# Kyqra integration boundary

Kyqra owns source registration, crawling, extraction, provenance, and durable callback scheduling.

The only business-system path is:

Kyqra crawler -> signed canonical event -> Middleware -> Odoo

The crawler never calls Odoo or an Odoo database. The canonical Middleware destination is
/api/v1/kyqra/results and uses the existing Codestra event signature and replay contract.
The old per-result endpoints are disabled unless KYQRA_LEGACY_CALLBACKS_ENABLED=true.

Every crawler result is marked review_required=true. Middleware and Odoo must retain that
state as review_pending until an authorized human approves it. No crawler event enables
email, SMS, voice, social publishing, or other external contact.

Source profiles contain only crawl policy and extraction configuration. Source credentials
and sessions remain separate secret-managed concerns and are not accepted by the public source
registration endpoint.
