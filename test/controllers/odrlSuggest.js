/* Copyright (c) 2026
 *
 * This file belongs to the business-ecosystem-logic-proxy of the
 * Business API Ecosystem. AGPL-3.0, see LICENSE.txt.
 */

'use strict';

const proxyquire = require('proxyquire').noCallThru();

describe('OdrlSuggest Controller', () => {
    let axiosMock;
    let controller;
    const sellerUser = { roles: [{ name: 'seller' }] };
    const buyerUser = { roles: [{ name: 'Buyer' }] };
    const validBody = {
        agent_card_url: 'http://avamet-agent-svc.avamet.svc.cluster.local:8001/agent/a2a-card.json',
        mcp_tools: [{ name: 'list_stations' }],
        seller_did: 'did:web:avamet.taile5f3a5.ts.net',
        gateway: 'avamet-agent-gw.avamet.svc.cluster.local',
        price: { standard: 5 },
        evil: 'no se reenvia'
    };

    const makeResponse = () => {
        const res = {};
        res.status = jasmine.createSpy('status').and.returnValue(res);
        res.json = jasmine.createSpy('json').and.returnValue(res);
        return res;
    };

    beforeEach(() => {
        axiosMock = jasmine.createSpy('axios');
        controller = proxyquire('../../controllers/odrlSuggest', {
            axios: axiosMock,
            '../config': {
                roles: { seller: 'Seller' },
                odrlSuggestUrl: 'http://odrl-suggest.test:8080/'
            },
            '../lib/utils': { hasRole: (u, r) => !!u && u.roles.some((x) => x.name.toLowerCase() === r.toLowerCase()) },
            '../lib/logger': { logger: { getLogger: () => ({ warn() {}, error() {} }) } }
        }).odrlSuggest();
    });

    it('forwards a validated payload to the service and returns its JSON', async () => {
        axiosMock.and.returnValue(Promise.resolve({ status: 200, data: { tiers: [{ id: 'basic' }] } }));
        const res = makeResponse();

        await controller.suggest({ user: sellerUser, body: JSON.stringify(validBody) }, res);

        const call = axiosMock.calls.mostRecent().args[0];
        expect(call.url).toBe('http://odrl-suggest.test:8080/suggest');
        expect(call.method).toBe('POST');
        expect(call.timeout).toBeGreaterThan(0);
        expect(call.maxRedirects).toBe(0);
        expect(call.maxContentLength).toBeGreaterThan(0);
        expect(call.data.evil).toBeUndefined();
        expect(call.data.seller_did).toBe(validBody.seller_did);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ tiers: [{ id: 'basic' }] });
    });

    it('rejects users without the seller role', async () => {
        const res = makeResponse();
        await controller.suggest({ user: buyerUser, body: JSON.stringify(validBody) }, res);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(axiosMock).not.toHaveBeenCalled();
    });

    it('rejects anonymous users', async () => {
        const res = makeResponse();
        await controller.suggest({ body: JSON.stringify(validBody) }, res);
        expect(res.status).toHaveBeenCalledWith(403);
    });

    it('rejects invalid JSON and oversize bodies', async () => {
        let res = makeResponse();
        await controller.suggest({ user: sellerUser, body: '{no json' }, res);
        expect(res.status).toHaveBeenCalledWith(400);

        res = makeResponse();
        await controller.suggest({ user: sellerUser, body: 'x'.repeat(600 * 1024) }, res);
        expect(res.status).toHaveBeenCalledWith(413);
        expect(axiosMock).not.toHaveBeenCalled();
    });

    const invalid = {
        'neither card nor url': { agent_card_url: undefined },
        'both card and url': { agent_card: { name: 'x' } },
        'non-http url': { agent_card_url: 'file:///etc/passwd' },
        'bad did': { seller_did: 'avamet' },
        'bad gateway': { gateway: 'a b' },
        'tools not a list': { mcp_tools: 'x' },
        'too many tools': { mcp_tools: new Array(201).fill({}) },
        'negative price': { price: -1 }
    };
    Object.keys(invalid).forEach((name) => {
        it('returns 400 for ' + name, async () => {
            const res = makeResponse();
            await controller.suggest({ user: sellerUser, body: JSON.stringify(Object.assign({}, validBody, invalid[name])) }, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(axiosMock).not.toHaveBeenCalled();
        });
    });

    it('relays 4xx details from the service', async () => {
        axiosMock.and.returnValue(Promise.reject({ response: { status: 422, data: { detail: 'host no permitido' } } }));
        const res = makeResponse();
        await controller.suggest({ user: sellerUser, body: JSON.stringify(validBody) }, res);
        expect(res.status).toHaveBeenCalledWith(422);
        expect(res.json).toHaveBeenCalledWith({ error: 'host no permitido' });
    });

    it('maps 5xx, timeouts and connection errors to 502/504', async () => {
        let res = makeResponse();
        axiosMock.and.returnValue(Promise.reject({ response: { status: 500, data: {} } }));
        await controller.suggest({ user: sellerUser, body: JSON.stringify(validBody) }, res);
        expect(res.status).toHaveBeenCalledWith(502);

        res = makeResponse();
        axiosMock.and.returnValue(Promise.reject({ code: 'ECONNABORTED' }));
        await controller.suggest({ user: sellerUser, body: JSON.stringify(validBody) }, res);
        expect(res.status).toHaveBeenCalledWith(504);

        res = makeResponse();
        axiosMock.and.returnValue(Promise.reject({ code: 'ECONNREFUSED' }));
        await controller.suggest({ user: sellerUser, body: JSON.stringify(validBody) }, res);
        expect(res.status).toHaveBeenCalledWith(502);
    });
});
