/* Avisos por correo: comparación de pedidos, destinatarios, plantillas y resumen mensual (sin red). */
const proxyquire = require('proxyquire');

describe('Notifications', function() {
    const notifications = proxyquire('../../lib/notifications', {
        axios: { get: function() { return Promise.resolve({ data: [] }); } },
        '../config': { mail: { enabled: true, adminEmail: 'admin@x.org', linkBase: 'https://m.example.eu' }, endpoints: {}, siop: {} },
        './utils': { getAPIURL: function() { return 'x'; } },
        './mailer': { mailer: { isEnabled: function() { return true; }, sendMail: function() { return Promise.resolve(true); } } }
    })._test;

    const mk = function(id, states, date) {
        return {
            id: id,
            orderDate: date,
            state: 'x',
            relatedParty: [{ id: 'urn:o:buyer', role: 'Buyer' }, { id: 'urn:o:sell', role: 'Seller' }],
            productOrderItem: states.map(function(s, i) {
                return {
                    id: id + '-i' + i,
                    state: s,
                    productOffering: { id: 'off' + i, name: 'Oferta ' + i },
                    product: { relatedParty: [{ id: 'urn:o:sell', role: 'Seller' }] }
                };
            })
        };
    };

    it('detects new orders and item state changes, and nothing else', function() {
        const o1 = mk('o1', ['acknowledged'], '2026-10-05T10:00:00Z');
        const o2 = mk('o2', [undefined, 'completed'], '2026-10-20T10:00:00Z');
        const snap = notifications.snapshotOf([o1]);

        let d = notifications.diffOrders(snap, [o1, o2]);
        expect(d.created.length).toBe(1);
        expect(d.changed.length).toBe(0);

        const o1b = JSON.parse(JSON.stringify(o1));
        o1b.productOrderItem[0].state = 'completed';
        d = notifications.diffOrders(snap, [o1b]);
        expect(d.changed.length).toBe(1);
        expect(d.changed[0].changes[0].from).toBe('acknowledged');
        expect(d.changed[0].changes[0].to).toBe('completed');

        d = notifications.diffOrders(snap, [o1]);
        expect(d.created.length + d.changed.length).toBe(0);
    });

    it('reads valid profile emails, preferred first, and ignores the rest', function() {
        const party = { contactMedium: [
            { mediumType: 'PostalAddress' },
            { mediumType: 'Email', characteristic: { emailAddress: 'a@b.es' } },
            { mediumType: 'Email', preferred: true, characteristic: { emailAddress: 'pref@b.es' } },
            { mediumType: 'Email', characteristic: { emailAddress: 'malo' } }
        ] };
        expect(notifications.emailsOfParty(party)).toEqual(['pref@b.es', 'a@b.es']);
        expect(notifications.emailsOfParty({})).toEqual([]);
    });

    it('sends the monthly summary once, from 8:00 (Madrid) of the first day, for the previous month', function() {
        expect(notifications.previousMonth(new Date('2026-11-01T09:00:00Z')).key).toBe('2026-10');
        expect(notifications.previousMonth(new Date('2027-01-03T09:00:00Z')).key).toBe('2026-12');
        expect(notifications.summaryDue(new Date('2026-11-01T06:00:00Z'), '2026-10')).toBe(false);
        expect(notifications.summaryDue(new Date('2026-11-01T08:30:00Z'), '2026-10')).toBe(true);
        expect(notifications.summaryDue(new Date('2026-11-01T08:30:00Z'), '2026-11')).toBe(false);
    });

    it('summarises only the orders of the month', function() {
        const pm = notifications.previousMonth(new Date('2026-11-01T09:00:00Z'));
        const orders = [
            mk('o1', ['acknowledged'], '2026-10-05T10:00:00Z'),
            mk('o2', [undefined, 'completed'], '2026-10-20T10:00:00Z'),
            mk('o3', ['failed'], '2026-09-30T10:00:00Z')
        ];
        const s = notifications.summarize(orders, pm.from, pm.to, {});
        expect(s.orders).toBe(2);
        expect(s.items).toBe(3);
        expect(s.byState.completed).toBe(1);
    });

    it('escapes user data in the emails and writes both languages', function() {
        const m = notifications.tmplNewRequestForSeller({ buyer: '<script>x</script>', offers: ['A&B'], orderId: 'o1', link: 'https://m' });
        expect(m.html).not.toContain('<script>x');
        expect(m.html).toContain('A&amp;B');
        const sc = notifications.tmplStateChangeForBuyer({ changes: [{ from: 'acknowledged', to: 'completed', offer: 'TETIS' }], orderId: 'o1', link: 'https://m' });
        expect(sc.html).toContain('Aceptada y completada');
        expect(sc.html).toContain('Accepted and completed');
    });
});
