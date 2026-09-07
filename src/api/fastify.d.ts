import type { ServicePrincipal } from '../types.js';

declare module 'fastify' {
  interface FastifyRequest {
    servicePrincipal: ServicePrincipal;
  }
}
