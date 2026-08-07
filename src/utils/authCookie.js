// Centralise les options du cookie du token JWT : httpOnly (inaccessible en JS, donc pas
// volable par une faille XSS, contrairement à un token en localStorage), secure + sameSite=none
// en production car le frontend (Vercel) et le backend (Railway) sont sur des domaines
// différents. En local, secure doit rester false sinon le navigateur refuse silencieusement de
// poser le cookie (pas de HTTPS sur localhost).
const NOM_COOKIE = 'renteasy_token';

const optionsCookie = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  path: '/',
};

function definirCookieAuth(res, token) {
  res.cookie(NOM_COOKIE, token, { ...optionsCookie, maxAge: 7 * 24 * 60 * 60 * 1000 });
}

function effacerCookieAuth(res) {
  res.clearCookie(NOM_COOKIE, optionsCookie);
}

module.exports = { NOM_COOKIE, definirCookieAuth, effacerCookieAuth };
