import type { HayratScope } from '../types.js';
import type { AccessClaims } from './claims.js';
import { isValidScopeTarget } from './claims.js';

export type ScopeResolver = (granted: HayratScope, target: HayratScope) => boolean;

/**
 * `can(role, ...targets)` — the ONLY authorization shape this contract supports.
 *
 * The role and its scopes travel together in the token, and the check honours
 * that pairing: find the grant for the role, then ask whether THAT grant's
 * scopes cover the targets. There is deliberately no `hasRole` and no
 * `inScope`, because a caller holding those two independently would write
 * `hasRole("moderator") && inScope(İzmir)` and authorize a cross product nobody
 * granted.
 *
 * Rules, in order:
 *
 *   - a malformed target denies, WITHOUT consulting the resolver — an
 *     application's hierarchy resolver is not asked to rule on `{type: "", id:
 *     -1}`, and this is checked first so a project-wide grant cannot rubber
 *     stamp a nonsense target either;
 *   - no grant for the role denies;
 *   - a grant with EMPTY scopes is project-wide for that role and allows,
 *     regardless of how many targets were passed;
 *   - a call with NO targets against a scoped grant denies: holding Ankara does
 *     not authorize a project-wide action;
 *   - several targets must ALL be covered (AND).
 *
 * Exact match on (type, id) first. The resolver is consulted only where exact
 * match fails, and only per granted×target pair: this SDK does not know that a
 * province contains its districts, and inventing that would put a second,
 * divergent copy of the hierarchy in every client.
 */
export function evaluateCan(
  claims: AccessClaims,
  role: string,
  targets: readonly HayratScope[],
  resolver?: ScopeResolver,
): boolean {
  if (typeof role !== 'string' || role.length === 0) return false;

  for (const target of targets) {
    if (!isValidScopeTarget(target)) return false;
  }

  const grant = claims.grants.find((candidate) => candidate.role === role);
  if (!grant) return false;

  if (grant.scopes.length === 0) return true;
  if (targets.length === 0) return false;

  return targets.every((target) => covers(grant.scopes, target, resolver));
}

function covers(granted: readonly HayratScope[], target: HayratScope, resolver?: ScopeResolver): boolean {
  for (const scope of granted) {
    if (scope.type === target.type && scope.id === target.id) return true;
  }
  if (!resolver) return false;
  for (const scope of granted) {
    let matched = false;
    try {
      matched = resolver(scope, target) === true;
    } catch {
      // An application resolver that throws denies. It is not the SDK's place
      // to turn somebody else's bug into an allow.
      matched = false;
    }
    if (matched) return true;
  }
  return false;
}
