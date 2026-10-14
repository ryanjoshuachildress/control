// Express 4 has no async-handler awareness: a rejection inside an async route
// handler or middleware becomes an unhandledRejection that kills the process
// instead of the express error pipeline (the old synchronous handlers threw
// inside express's own try/catch, so 4xx/5xx still landed correctly). This
// factory wraps every handler whose rejections would otherwise escape.
//
//   const router = require('../lib/router')();
//   router.get('/x', async (req, res) => { ... })  // errors now reach next(err)
//
// Error middleware (4 args) and multer's manual next(err) flows pass through
// untouched.
const express = require('express');

const ASYNCABLE = ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'];

function wrap(handler) {
  if (typeof handler !== 'function') return handler;
  if (handler.length === 4) return handler; // error middleware: leave it
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function router(opts) {
  const r = express.Router(opts);
  for (const verb of ASYNCABLE) {
    const orig = r[verb].bind(r);
    r[verb] = ((...args) => orig(...args.map(wrap)));
  }
  return r;
}

router.app = (app) => {
  for (const verb of ASYNCABLE) {
    if (typeof app[verb] !== 'function') continue;
    const orig = app[verb].bind(app);
    app[verb] = (...args) => orig(...args.map(wrap));
  }
  return app;
};

module.exports = router;