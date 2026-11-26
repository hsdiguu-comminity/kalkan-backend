// Amir Ali — Rol kontrolü. Roller arasında hiyerarşi yoktur: admin kendiliğinden uzman veya
// kullanıcı yetkisi almaz (destek sözleşmesi). Kaynak sahipliği burada değil, ilgili serviste
// kontrol edilir.
import type { RequestHandler } from "express";
import { getPrincipal, type Role } from "./authenticate.js";
import { AppError } from "./errorHandler.js";

export function authorize(...roles: [Role, ...Role[]]): RequestHandler {
  const allowed: ReadonlySet<Role> = new Set(roles);
  return (request, _response, next) => {
    const principal = getPrincipal(request);
    if (!allowed.has(principal.role)) throw new AppError("FORBIDDEN");
    next();
  };
}
