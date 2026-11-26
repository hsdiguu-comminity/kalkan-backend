/**
 * Amir Ali — Rol kontrolü (user / expert / admin).
 * authenticate middleware'inden sonra kullanılır. Roller arasında hiyerarşi yoktur: admin rolü
 * kendiliğinden uzman veya kullanıcı yetkisi vermez; her yol izin verdiği rolleri açıkça yazar.
 * Kaynak sahipliği (ör. "bu oturum bu kullanıcıya mı ait?") burada değil, ilgili serviste kontrol edilir.
 */
import type { RequestHandler } from "express";
import { getPrincipal, type Role } from "./authenticate.js";
import { AppError } from "./errorHandler.js";

/**
 * Yalnızca verilen rollerden birine sahip kullanıcıların geçmesine izin verir.
 * Kimlik yoksa 401 UNAUTHENTICATED, rol uygun değilse 403 FORBIDDEN döner.
 *
 * @example
 * router.post("/sessions/:id/accept", authenticate, authorize("expert"), handler);
 */
export function authorize(...roles: [Role, ...Role[]]): RequestHandler {
  const allowed: ReadonlySet<Role> = new Set(roles);
  return (request, _response, next) => {
    const principal = getPrincipal(request);
    if (!allowed.has(principal.role)) throw new AppError("FORBIDDEN");
    next();
  };
}
