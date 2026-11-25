/* Copyright (c) 2026
 *
 * This file belongs to the business-ecosystem-logic-proxy of the
 * Business API Ecosystem
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

const axios = require('axios');
const config = require('../config');
const utils = require('../lib/utils');
const logger = require('../lib/logger').logger.getLogger('OdrlSuggest');

const MAX_BODY_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TOOLS = 200;
const TIMEOUT_MS = 20000;

function odrlSuggest() {
    const isString = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

    // Valida el cuerpo y devuelve {error} o {payload} (solo campos conocidos, hacia el servicio odrl-suggest)
    const validate = function(body) {
        if (body == null || typeof body !== 'object' || Array.isArray(body)) {
            return { error: 'The body must be a JSON object' };
        }
        const hasUrl = body.agent_card_url != null && body.agent_card_url !== '';
        const hasCard = body.agent_card != null;
        if (hasUrl === hasCard) {
            return { error: 'Provide exactly one of agent_card_url or agent_card' };
        }
        const payload = {};
        if (hasUrl) {
            if (!isString(body.agent_card_url, 2048) || !/^https?:\/\//i.test(body.agent_card_url)) {
                return { error: 'agent_card_url must be an http(s) URL' };
            }
            payload.agent_card_url = body.agent_card_url;
        } else {
            if (typeof body.agent_card !== 'object' || Array.isArray(body.agent_card)) {
                return { error: 'agent_card must be a JSON object' };
            }
            payload.agent_card = body.agent_card;
        }
        if (body.mcp_tools != null) {
            if (!Array.isArray(body.mcp_tools) || body.mcp_tools.length > MAX_TOOLS
                || body.mcp_tools.some((t) => t == null || typeof t !== 'object' || Array.isArray(t))) {
                return { error: `mcp_tools must be a list of at most ${MAX_TOOLS} objects` };
            }
            payload.mcp_tools = body.mcp_tools;
        }
        if (!isString(body.seller_did, 300) || !/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(body.seller_did)) {
            return { error: 'seller_did must be a valid DID' };
        }
        if (!isString(body.gateway, 253) || !/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(body.gateway)) {
            return { error: 'gateway must be a host name' };
        }
        payload.seller_did = body.seller_did;
        payload.gateway = body.gateway;
        if (body.agent_id != null) {
            if (!isString(body.agent_id, 63) || !/^[a-z0-9][a-z0-9-]*$/.test(body.agent_id)) {
                return { error: 'agent_id must be a lowercase identifier' };
            }
            payload.agent_id = body.agent_id;
        }
        if (body.price != null) {
            const ok = (n) => typeof n === 'number' && isFinite(n) && n >= 0;
            const valid = ok(body.price)
                || (typeof body.price === 'object' && !Array.isArray(body.price) && Object.values(body.price).every(ok));
            if (!valid) {
                return { error: 'price must be a non-negative number or an object of non-negative numbers' };
            }
            payload.price = body.price;
        }
        return { payload: payload };
    };

    const suggest = async function(req, res) {
        // La ruta ya exige autenticación; aquí se exige además el rol vendedor
        if (!utils.hasRole(req.user, config.roles.seller)) {
            return res.status(403).json({ error: 'Only users with the seller role can request ODRL policy suggestions' });
        }

        if (typeof req.body === 'string' && req.body.length > MAX_BODY_BYTES) {
            return res.status(413).json({ error: 'Request body too large' });
        }

        let body;
        try {
            body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        } catch (_) {
            return res.status(400).json({ error: 'Invalid JSON body' });
        }

        const checked = validate(body);
        if (checked.error) {
            return res.status(400).json({ error: checked.error });
        }

        const base = (config.odrlSuggestUrl || '').replace(/\/+$/, '');
        try {
            const resp = await axios({
                method: 'POST',
                url: base + '/suggest',
                data: checked.payload,
                headers: { 'Content-Type': 'application/json' },
                timeout: TIMEOUT_MS,
                maxRedirects: 0,
                maxContentLength: MAX_RESPONSE_BYTES,
                maxBodyLength: MAX_BODY_BYTES
            });
            return res.status(200).json(resp.data);
        } catch (error) {
            if (error.response) {
                // El servicio rechazó la petición (p. ej. 422: host de la agent card no permitido)
                const status = error.response.status;
                const detail = error.response.data && error.response.data.detail;
                logger.warn(`odrl-suggest responded ${status}`);
                if (status >= 400 && status < 500) {
                    return res.status(status).json({ error: typeof detail === 'string' ? detail : 'Invalid request for the ODRL suggestion service' });
                }
                return res.status(502).json({ error: `ODRL suggestion service error (HTTP ${status})` });
            }
            if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
                logger.error('odrl-suggest timeout');
                return res.status(504).json({ error: 'The ODRL suggestion service did not answer in time' });
            }
            logger.error('odrl-suggest unavailable: ' + (error.code || error.message));
            return res.status(502).json({ error: 'The ODRL suggestion service is not available' });
        }
    };

    return {
        suggest: suggest,
        validate: validate
    };
}

exports.odrlSuggest = odrlSuggest;
