/* Avisos por correo del marketplace.
 *
 *  - Solicitud nueva de una oferta  -> correo al proveedor (y confirmación al comprador).
 *  - Cambio de estado de un pedido (aceptado, en curso, completado, rechazado...) -> correo al comprador.
 *  - Resumen mensual -> correo al dueño del espacio de datos (config.mail.adminEmail).
 *
 * Los pedidos se comparan cada pocos segundos con la última instantánea guardada en Mongo, así se
 * detectan también los cambios que hace el contract-management directamente en la API TMF (sin pasar
 * por este proxy). Las direcciones salen del perfil de la organización (contactMedium de tipo Email):
 * si no hay correo en el perfil, no se envía nada a esa parte.
 */
const axios = require('axios');
const config = require('../config');
const utils = require('./utils');
const { mailer } = require('./mailer');
const logger = require('./logger').logger.getLogger('Notifications');

const BUYER_ROLES = ['buyer', 'customer'];
const SELLER_ROLES = ['seller', 'provider'];

// ---------------------------------------------------------------------------------------------
// Utilidades puras (se prueban sin red ni base de datos)
// ---------------------------------------------------------------------------------------------

const esc = (v) =>
    String(v == null ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

const itemState = (item) => String((item && item.state) || 'unchecked');

const STATE_LABEL = {
    unchecked: { es: 'Pendiente de revisar', en: 'Pending review' },
    acknowledged: { es: 'Recibida', en: 'Received' },
    inProgress: { es: 'En tramitación', en: 'In progress' },
    pending: { es: 'Pendiente', en: 'Pending' },
    completed: { es: 'Aceptada y completada', en: 'Accepted and completed' },
    failed: { es: 'Rechazada', en: 'Rejected' },
    cancelled: { es: 'Cancelada', en: 'Cancelled' }
};
const label = (state, lang) => (STATE_LABEL[state] || { es: state, en: state })[lang];

const snapshotOf = (orders) => {
    const snap = {};
    for (const o of orders) {
        const items = {};
        for (const it of o.productOrderItem || []) items[it.id] = itemState(it);
        snap[o.id] = { state: o.state || '', items };
    }
    return snap;
};

/** Pedidos nuevos y cambios de estado de los elementos respecto a la instantánea anterior. */
const diffOrders = (prev, orders) => {
    const created = [];
    const changed = [];
    for (const o of orders) {
        const before = prev[o.id];
        if (!before) {
            created.push(o);
            continue;
        }
        const changes = [];
        for (const it of o.productOrderItem || []) {
            const from = before.items[it.id];
            const to = itemState(it);
            if (from !== undefined && from !== to) changes.push({ item: it, from, to });
        }
        if (changes.length) changed.push({ order: o, changes });
    }
    return { created, changed };
};

const partiesWithRole = (parties, roles) =>
    (parties || []).filter((p) => p && p.id && roles.includes(String(p.role || '').toLowerCase()));

const uniqueById = (list) => {
    const seen = new Set();
    return list.filter((p) => (seen.has(p.id) ? false : seen.add(p.id)));
};

const buyersOf = (order) => {
    let b = partiesWithRole(order.relatedParty, BUYER_ROLES);
    if (!b.length) {
        b = [];
        for (const it of order.productOrderItem || []) b.push(...partiesWithRole(it.product && it.product.relatedParty, BUYER_ROLES));
    }
    return uniqueById(b);
};

const sellersOfItem = (order, item) => {
    let s = partiesWithRole(item.product && item.product.relatedParty, SELLER_ROLES);
    if (!s.length) s = partiesWithRole(order.relatedParty, SELLER_ROLES);
    return uniqueById(s);
};

/** Correos del perfil (contactMedium Email): el preferido primero. */
const emailsOfParty = (party) => {
    const media = ((party && party.contactMedium) || []).filter(
        (m) => String(m.mediumType || '').toLowerCase() === 'email' && m.characteristic && m.characteristic.emailAddress
    );
    media.sort((a, b) => Number(!!b.preferred) - Number(!!a.preferred));
    const out = [];
    for (const m of media) {
        const e = String(m.characteristic.emailAddress).trim();
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !out.includes(e)) out.push(e);
    }
    return out;
};

const madridParts = (date) => {
    const f = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
    });
    const p = {};
    for (const x of f.formatToParts(date)) p[x.type] = x.value;
    return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) };
};
const monthKey = (y, m) => `${y}-${String(m).padStart(2, '0')}`;

/** Mes anterior al de `date` (hora de Madrid): clave y límites [from, to) en UTC aproximado. */
const previousMonth = (date) => {
    const { y, m } = madridParts(date);
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    return {
        key: monthKey(py, pm),
        from: new Date(Date.UTC(py, pm - 1, 1)),
        to: new Date(Date.UTC(y, m - 1, 1)),
        name: { es: new Date(Date.UTC(py, pm - 1, 15)).toLocaleDateString('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
                en: new Date(Date.UTC(py, pm - 1, 15)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }) }
    };
};

/** El resumen toca cuando ya es día 1 o posterior, pasadas las 8:00 (Madrid), y el mes actual no se ha tratado. */
const summaryDue = (date, lastMonthKey) => {
    const { y, m, h } = madridParts(date);
    return monthKey(y, m) !== lastMonthKey && h >= 8;
};

const orderDate = (o) => new Date(o.orderDate || o.creationDate || o.requestedStartDate || 0);

const countBy = (arr, fn) => {
    const c = {};
    for (const x of arr) {
        const k = fn(x);
        c[k] = (c[k] || 0) + 1;
    }
    return c;
};

/** Cifras del resumen mensual. `names` traduce ids de oferta/organización a nombres. */
const summarize = (orders, from, to, names = {}) => {
    const inMonth = orders.filter((o) => {
        const d = orderDate(o);
        return d >= from && d < to;
    });
    const items = inMonth.flatMap((o) => (o.productOrderItem || []).map((it) => ({ order: o, item: it })));
    const nameOf = (id, fallback) => names[id] || fallback || id;
    const byOffer = countBy(items, (x) => nameOf(x.item.productOffering && x.item.productOffering.id, x.item.productOffering && x.item.productOffering.name));
    const byBuyer = countBy(inMonth, (o) => buyersOf(o).map((b) => nameOf(b.id, b.name)).join(', ') || '—');
    const bySeller = countBy(items, (x) => sellersOfItem(x.order, x.item).map((s) => nameOf(s.id, s.name)).join(', ') || '—');
    const byState = countBy(items, (x) => itemState(x.item));
    const top = (obj, n = 10) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
    return {
        orders: inMonth.length,
        items: items.length,
        byState,
        byOffer: top(byOffer),
        byBuyer: top(byBuyer),
        bySeller: top(bySeller),
        totalOrdersEver: orders.length
    };
};

// ---------------------------------------------------------------------------------------------
// Plantillas (español primero, inglés debajo)
// ---------------------------------------------------------------------------------------------

const layout = ({ subject, es, en, linkUrl, linkEs, linkEn }) => {
    const block = (lang, body, linkText) => `
      <div style="margin:0 0 20px">${body}</div>
      ${linkUrl ? `<p style="margin:0 0 8px"><a href="${esc(linkUrl)}" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${esc(linkText)}</a></p>` : ''}`;
    const html = `<!doctype html><html lang="es"><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;max-width:620px;margin:auto;padding:16px">
      <h2 style="color:#312e81;margin:0 0 16px">${esc(subject)}</h2>
      ${block('es', es, linkEs)}
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
      <div lang="en" style="color:#4b5563">${block('en', en, linkEn)}</div>
      <p style="font-size:12px;color:#9ca3af;margin-top:28px">Marketplace del espacio de datos PGTEC · PGTEC data space marketplace.<br>
      Recibes este mensaje porque el correo figura en el perfil de tu organización. / You receive this message because this address is in your organisation's profile.</p>
    </body></html>`;
    const strip = (h) => h.replace(/<br\s*\/?>/g, '\n').replace(/<\/(p|li|div|h\d)>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const text = `${strip(es).trim()}\n${linkUrl ? `${linkEs}: ${linkUrl}\n` : ''}\n---\n${strip(en).trim()}\n${linkUrl ? `${linkEn}: ${linkUrl}` : ''}`;
    return { html, text };
};

const itemsList = (rows, lang) =>
    `<ul style="padding-left:18px;margin:8px 0">${rows.map((r) => `<li>${r(lang)}</li>`).join('')}</ul>`;

const tmplNewRequestForSeller = ({ buyer, offers, orderId, link }) => {
    const subject = `Nueva solicitud de acceso: ${offers.join(', ')} / New access request`;
    const es = `<p><b>${esc(buyer)}</b> ha solicitado acceso a:</p>${itemsList(offers.map((o) => () => `«${esc(o)}»`), 'es')}
      <p>Puedes revisar y aceptar la solicitud en el apartado <i>Pedidos</i> del marketplace (pedido <code>${esc(orderId)}</code>).</p>`;
    const en = `<p><b>${esc(buyer)}</b> has requested access to:</p>${itemsList(offers.map((o) => () => `«${esc(o)}»`), 'en')}
      <p>You can review and accept the request in the <i>Orders</i> section of the marketplace (order <code>${esc(orderId)}</code>).</p>`;
    return { subject, ...layout({ subject, es, en, linkUrl: link, linkEs: 'Ver pedidos', linkEn: 'View orders' }) };
};

const tmplNewRequestForBuyer = ({ offers, orderId, link }) => {
    const subject = `Hemos recibido tu solicitud / We received your request`;
    const rows = offers.map((o) => () => `«${esc(o)}»`);
    const es = `<p>Hemos registrado tu solicitud para:</p>${itemsList(rows, 'es')}
      <p>El proveedor la revisará y recibirás un correo cuando cambie su estado. Puedes seguirla en <i>Pedidos</i> (pedido <code>${esc(orderId)}</code>).</p>`;
    const en = `<p>We have registered your request for:</p>${itemsList(rows, 'en')}
      <p>The provider will review it and you will get an email when its status changes. You can follow it under <i>Orders</i> (order <code>${esc(orderId)}</code>).</p>`;
    return { subject, ...layout({ subject, es, en, linkUrl: link, linkEs: 'Ver mis pedidos', linkEn: 'View my orders' }) };
};

const HEADLINE = {
    completed: { es: 'Tu solicitud ha sido aceptada. Ya puedes usar el servicio o los datos.', en: 'Your request has been accepted. You can now use the service or data.' },
    acknowledged: { es: 'El proveedor ha recibido tu solicitud.', en: 'The provider has received your request.' },
    inProgress: { es: 'Tu solicitud está en tramitación.', en: 'Your request is being processed.' },
    failed: { es: 'Tu solicitud ha sido rechazada.', en: 'Your request has been rejected.' },
    cancelled: { es: 'Tu solicitud ha sido cancelada.', en: 'Your request has been cancelled.' }
};
// Prioridad del titular cuando varios elementos cambian a la vez
const HEADLINE_ORDER = ['completed', 'failed', 'cancelled', 'inProgress', 'acknowledged'];

const tmplStateChangeForBuyer = ({ changes, orderId, link }) => {
    const top = HEADLINE_ORDER.find((s) => changes.some((c) => c.to === s)) || changes[0].to;
    const h = HEADLINE[top] || { es: 'Ha cambiado el estado de tu solicitud.', en: 'The status of your request has changed.' };
    const subject = `${h.es.split('.')[0]} / ${h.en.split('.')[0]}`;
    const rows = (lang) => changes.map((c) => () => `«${esc(c.offer)}»: ${esc(label(c.from, lang))} → <b>${esc(label(c.to, lang))}</b>`);
    const es = `<p>${esc(h.es)}</p>${itemsList(rows('es'), 'es')}<p>Pedido <code>${esc(orderId)}</code>.</p>`;
    const en = `<p>${esc(h.en)}</p>${itemsList(rows('en'), 'en')}<p>Order <code>${esc(orderId)}</code>.</p>`;
    return { subject, ...layout({ subject, es, en, linkUrl: link, linkEs: 'Ver mis pedidos', linkEn: 'View my orders' }) };
};

const tmplCancelledForSeller = ({ buyer, offers, orderId, link }) => {
    const subject = `Solicitud cancelada: ${offers.join(', ')} / Request cancelled`;
    const rows = offers.map((o) => () => `«${esc(o)}»`);
    const es = `<p><b>${esc(buyer)}</b> ha cancelado su solicitud de:</p>${itemsList(rows, 'es')}<p>Pedido <code>${esc(orderId)}</code>.</p>`;
    const en = `<p><b>${esc(buyer)}</b> has cancelled the request for:</p>${itemsList(rows, 'en')}<p>Order <code>${esc(orderId)}</code>.</p>`;
    return { subject, ...layout({ subject, es, en, linkUrl: link, linkEs: 'Ver pedidos', linkEn: 'View orders' }) };
};

const tmplMonthlySummary = ({ period, s, link }) => {
    const subject = `Resumen mensual del marketplace: ${period.name.es} / Monthly summary: ${period.name.en}`;
    const table = (rows, lang) =>
        rows.length
            ? `<table style="border-collapse:collapse;margin:6px 0 14px;width:100%">${rows.map(([k, v]) => `<tr><td style="padding:3px 8px;border-bottom:1px solid #e5e7eb">${esc(k)}</td><td style="padding:3px 8px;border-bottom:1px solid #e5e7eb;text-align:right"><b>${v}</b></td></tr>`).join('')}</table>`
            : `<p style="color:#6b7280">${lang === 'es' ? 'Sin datos.' : 'No data.'}</p>`;
    const stateRows = (lang) => Object.entries(s.byState).map(([k, v]) => [label(k, lang), v]);
    const body = (lang) => {
        const t = lang === 'es'
            ? { h: `Actividad de ${period.name.es}`, o: 'Solicitudes (pedidos)', i: 'Ofertas solicitadas', st: 'Estado actual de los elementos', of: 'Ofertas más solicitadas', se: 'Proveedores con más solicitudes', bu: 'Organizaciones que más solicitan', tot: 'Pedidos totales desde el inicio' }
            : { h: `Activity in ${period.name.en}`, o: 'Requests (orders)', i: 'Offers requested', st: 'Current status of the items', of: 'Most requested offers', se: 'Providers with most requests', bu: 'Organisations requesting most', tot: 'Total orders since the start' };
        return `<p><b>${t.h}</b></p>
          ${table([[t.o, s.orders], [t.i, s.items], [t.tot, s.totalOrdersEver]], lang)}
          <p><b>${t.st}</b></p>${table(stateRows(lang), lang)}
          <p><b>${t.of}</b></p>${table(s.byOffer, lang)}
          <p><b>${t.se}</b></p>${table(s.bySeller, lang)}
          <p><b>${t.bu}</b></p>${table(s.byBuyer, lang)}`;
    };
    return { subject, ...layout({ subject, es: body('es'), en: body('en'), linkUrl: link, linkEs: 'Abrir el marketplace', linkEn: 'Open the marketplace' }) };
};

// ---------------------------------------------------------------------------------------------
// Acceso a las APIs
// ---------------------------------------------------------------------------------------------

const cache = new Map(); // id -> { at, value } (nombres y correos; caducan a los 10 min)
const TTL = 10 * 60 * 1000;
const cached = async (key, loader) => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL) return hit.value;
    const value = await loader();
    cache.set(key, { at: Date.now(), value });
    return value;
};

const apiUrl = (endpoint, path) => utils.getAPIURL(endpoint.appSsl, endpoint.host, endpoint.port, `${endpoint.apiPath}${path}`);

const fetchOrders = async () => {
    const all = [];
    const limit = 100;
    for (let offset = 0, page = 0; page < 50; page++, offset += limit) {
        const res = await axios.get(apiUrl(config.endpoints.ordering, `/productOrder?limit=${limit}&offset=${offset}`));
        const list = Array.isArray(res.data) ? res.data : [];
        all.push(...list);
        if (list.length < limit) break;
    }
    return all;
};

const loadParty = async (id) => {
    const { partyClient } = require('./party');
    return cached(`party:${id}`, async () => {
        try {
            const r = /individual/i.test(id) ? await partyClient.getIndividual(id) : await partyClient.getOrganization(id);
            return r.body;
        } catch (e) {
            logger.warn(`Party ${id} not available: ${e && (e.message || e.status)}`);
            return null;
        }
    });
};

const partyName = async (p) => {
    const party = await loadParty(p.id);
    return (party && (party.tradingName || party.name || party.formattedName)) || p.name || p.id;
};

const partyEmails = async (p) => emailsOfParty(await loadParty(p.id));

const offerName = async (item) => {
    const o = item.productOffering || {};
    if (o.name) return o.name;
    if (!o.id) return item.id;
    return cached(`offer:${o.id}`, async () => {
        try {
            const r = await axios.get(apiUrl(config.endpoints.catalog, `/productOffering/${o.id}`));
            return r.data.name || o.id;
        } catch (e) {
            return o.id;
        }
    });
};

const linkBase = () => {
    if (config.mail.linkBase) return config.mail.linkBase.replace(/\/$/, '');
    try {
        return new URL(config.siop.callbackURL).origin;
    } catch (e) {
        return '';
    }
};
const ordersLink = () => (linkBase() ? `${linkBase()}/product-orders` : '');

// ---------------------------------------------------------------------------------------------
// Envío
// ---------------------------------------------------------------------------------------------

const sendNewOrder = async (order) => {
    const link = ordersLink();
    const buyers = buyersOf(order);
    const buyerName = buyers.length ? (await Promise.all(buyers.map(partyName))).join(', ') : '—';

    // Elementos agrupados por proveedor
    const bySeller = new Map();
    for (const it of order.productOrderItem || []) {
        for (const s of sellersOfItem(order, it)) {
            if (!bySeller.has(s.id)) bySeller.set(s.id, { party: s, offers: [] });
            bySeller.get(s.id).offers.push(await offerName(it));
        }
    }
    for (const { party, offers } of bySeller.values()) {
        const to = await partyEmails(party);
        if (!to.length) { logger.info(`Seller ${party.id} has no email in the profile: no notification`); continue; }
        await mailer.sendMail({ to, ...tmplNewRequestForSeller({ buyer: buyerName, offers, orderId: order.id, link }) });
    }

    const offersAll = [];
    for (const it of order.productOrderItem || []) offersAll.push(await offerName(it));
    for (const b of buyers) {
        const to = await partyEmails(b);
        if (!to.length) { logger.info(`Buyer ${b.id} has no email in the profile: no notification`); continue; }
        await mailer.sendMail({ to, ...tmplNewRequestForBuyer({ offers: offersAll, orderId: order.id, link }) });
    }
};

const sendStateChanges = async ({ order, changes }) => {
    const link = ordersLink();
    const named = [];
    for (const c of changes) named.push({ from: c.from, to: c.to, offer: await offerName(c.item), item: c.item });

    for (const b of buyersOf(order)) {
        const to = await partyEmails(b);
        if (!to.length) { logger.info(`Buyer ${b.id} has no email in the profile: no notification`); continue; }
        await mailer.sendMail({ to, ...tmplStateChangeForBuyer({ changes: named, orderId: order.id, link }) });
    }

    // Si el comprador cancela, avisamos al proveedor
    const cancelled = named.filter((c) => c.to === 'cancelled');
    if (cancelled.length) {
        const buyerName = (await Promise.all(buyersOf(order).map(partyName))).join(', ') || '—';
        const bySeller = new Map();
        for (const c of cancelled) for (const s of sellersOfItem(order, c.item)) {
            if (!bySeller.has(s.id)) bySeller.set(s.id, { party: s, offers: [] });
            bySeller.get(s.id).offers.push(c.offer);
        }
        for (const { party, offers } of bySeller.values()) {
            const to = await partyEmails(party);
            if (to.length) await mailer.sendMail({ to, ...tmplCancelledForSeller({ buyer: buyerName, offers, orderId: order.id, link }) });
        }
    }
};

const sendMonthlySummary = async (orders, period) => {
    if (!config.mail.adminEmail) return;
    const names = {};
    for (const o of orders) {
        for (const it of o.productOrderItem || []) {
            const oid = it.productOffering && it.productOffering.id;
            if (oid && !names[oid]) names[oid] = await offerName(it);
            for (const p of [...buyersOf(o), ...sellersOfItem(o, it)]) if (!names[p.id]) names[p.id] = await partyName(p);
        }
    }
    const s = summarize(orders, period.from, period.to, names);
    await mailer.sendMail({ to: config.mail.adminEmail, ...tmplMonthlySummary({ period, s, link: linkBase() }) });
};

// ---------------------------------------------------------------------------------------------
// Bucle principal
// ---------------------------------------------------------------------------------------------

let running = false;

const tick = async (now = new Date()) => {
    if (running || !mailer.isEnabled()) return;
    running = true;
    try {
        const State = require('../db/schemas/mailState');
        const orders = await fetchOrders();
        let st = await State.findById('state');
        if (!st) st = new State({ _id: 'state' });
        const current = monthKey(madridParts(now).y, madridParts(now).m);

        if (!st.baselined) {
            // Primera ejecución: se toma la foto actual sin enviar nada (evita avisar de pedidos antiguos)
            st.snapshot = snapshotOf(orders);
            st.baselined = true;
            st.summaryMonth = current;
            st.markModified('snapshot');
            await st.save();
            logger.info(`Baseline of ${orders.length} order(s) stored; no mail sent`);
            return;
        }

        const { created, changed } = diffOrders(st.snapshot || {}, orders);
        // Se guarda la foto antes de enviar: como mucho una vez cada aviso (sin bucles si el SMTP falla)
        st.snapshot = snapshotOf(orders);
        st.markModified('snapshot');
        await st.save();

        for (const o of created) await sendNewOrder(o).catch((e) => logger.error(`New order mail failed: ${e && e.message}`));
        for (const c of changed) await sendStateChanges(c).catch((e) => logger.error(`State mail failed: ${e && e.message}`));

        if (summaryDue(now, st.summaryMonth)) {
            st.summaryMonth = current;
            await st.save();
            await sendMonthlySummary(orders, previousMonth(now)).catch((e) => logger.error(`Monthly summary failed: ${e && e.message}`));
        }
    } catch (e) {
        logger.error(`Notification cycle failed: ${e && e.message}`);
    } finally {
        running = false;
    }
};

const start = () => {
    if (!mailer.isEnabled()) {
        logger.info('Mail notifications disabled (BAE_LP_MAIL_ENABLED / SMTP not configured)');
        return;
    }
    const every = Math.max(30, config.mail.pollSeconds) * 1000;
    logger.info(`Mail notifications enabled; checking orders every ${every / 1000}s`);
    setTimeout(() => tick(), 30 * 1000);
    setInterval(() => tick(), every);
};

exports.notifications = { start, tick };
// Exportado solo para pruebas
exports._test = {
    snapshotOf, diffOrders, emailsOfParty, buyersOf, sellersOfItem, summarize, summaryDue, previousMonth, madridParts,
    tmplNewRequestForSeller, tmplNewRequestForBuyer, tmplStateChangeForBuyer, tmplCancelledForSeller, tmplMonthlySummary, esc
};
