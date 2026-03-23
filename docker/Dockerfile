FROM node:18 AS build

ARG THEME

WORKDIR /opt/business-ecosystem-logic-proxy

COPY ./ .

RUN mkdir -p themes && \
    export USER=root && \
    npm install --unsafe && \
    mkdir etc && \
    cp config.js etc/config.js && \
    echo "module.exports = require('./etc/config');" > config.js && \
    if [ ! -z "$THEME" ] ; then cd themes && git clone ${THEME} ; fi

FROM node:18 AS main

LABEL MAINTAINER="Future Internet Consulting and Development Solutions S.L."

COPY --from=build /opt/business-ecosystem-logic-proxy /opt/business-ecosystem-logic-proxy

WORKDIR /opt/business-ecosystem-logic-proxy

RUN apt-get update && apt-get install -y xinetd wget curl git

COPY ./docker/entrypoint.sh /
COPY ./docker/getConfig.js /opt/business-ecosystem-logic-proxy
COPY ./docker/proxy-themes/bae-frontend /opt/business-ecosystem-logic-proxy/portal/bae-frontend

ENV NODE_ENV=development \
    DATASPACE_ENABLED=true \
    BAE_LP_DATASPACE_ENABLED=true \
    COLLECT=True \
    BAE_LP_PORT=8000 \
    BAE_LP_HOST=proxy.docker \
    BAE_LP_OAUTH2_SERVER=http://idm.docker:8000 \
    BAE_LP_OAUTH2_CLIENT_ID=id \
    BAE_LP_OAUTH2_CLIENT_SECRET=secret \
    BAE_LP_OAUTH2_CALLBACK=http://proxy.docker:8004/auth/fiware/callback \
    BAE_LP_OAUTH2_ADMIN_ROLE=admin \
    BAE_LP_OAUTH2_SELLER_ROLE=seller \
    BAE_LP_OAUTH2_CUSTOMER_ROLE=customer \
    BAE_LP_OAUTH2_ORG_ADMIN_ROLE=orgAdmin \
    BAE_LP_OAUTH2_IS_LEGACY=false \
    BAE_LP_THEME=PGTEC \
    BAE_LP_MONGO_SERVER=mongo \
    BAE_LP_MONGO_PORT=27017 \
    BAE_LP_MONGO_DB=belp \
    BAE_LP_REVENUE_MODEL=0


COPY ./docker/proxy-themes /opt/business-ecosystem-logic-proxy/themes
COPY ./docker/proxy-static /opt/business-ecosystem-logic-proxy/static
COPY ./docker/proxy-locales /opt/business-ecosystem-logic-proxy/locales

EXPOSE 8004

HEALTHCHECK CMD curl --fail http://localhost:8004/version || exit 1


ENTRYPOINT ["/entrypoint.sh"]
