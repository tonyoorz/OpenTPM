const passport = require('passport');
const { logger } = require('@librechat/data-schemas');

const requireBmwSsoAuth = (req, res, next) => {
  passport.authenticate('bmw-sso', (err, user, info) => {
    if (err) {
      logger.error('[requireBmwSsoAuth] Error at passport.authenticate:', err);
      return next(err);
    }
    if (!user) {
      logger.debug('[requireBmwSsoAuth] Error: No user');
      return res.status(404).send(info);
    }
    if (info && info.message) {
      logger.debug('[requireBmwSsoAuth] Error: ' + info.message);
      return res.status(422).send({ message: info.message });
    }
    req.user = user;
    next();
  })(req, res, next);
};

module.exports = requireBmwSsoAuth;
