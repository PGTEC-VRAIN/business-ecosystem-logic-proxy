/* Envío de correo por SMTP (nodemailer). Nunca lanza: si falla o está desactivado, lo registra y sigue. */
const config = require('../config');
const logger = require('./logger').logger.getLogger('Mailer');

let transporter = null;

const isEnabled = function() {
    const m = config.mail || {};
    return !!(m.enabled && m.host && m.user && m.password && m.from);
};

const getTransporter = function() {
    if (!transporter) {
        const nodemailer = require('nodemailer'); // carga perezosa: solo hace falta si hay correo activado
        transporter = nodemailer.createTransport({
            host: config.mail.host,
            port: config.mail.port,
            secure: config.mail.secure,
            auth: { user: config.mail.user, pass: config.mail.password }
        });
    }
    return transporter;
};

// Sustituye el transporte (para pruebas)
const setTransporter = function(t) {
    transporter = t;
};

/** @returns {Promise<boolean>} true si se ha entregado al servidor SMTP */
const sendMail = async function({ to, subject, text, html }) {
    if (!isEnabled()) return false;
    const recipients = [].concat(to || []).filter(Boolean);
    if (recipients.length === 0) return false;
    try {
        await getTransporter().sendMail({
            from: `"${config.mail.fromName}" <${config.mail.from}>`,
            to: recipients.join(', '),
            replyTo: config.mail.replyTo || undefined,
            subject,
            text,
            html
        });
        logger.info(`Mail sent to ${recipients.length} recipient(s): ${subject}`);
        return true;
    } catch (err) {
        logger.error(`Mail could not be sent (${subject}): ${err && err.message}`);
        return false;
    }
};

exports.mailer = { isEnabled, sendMail, setTransporter };
