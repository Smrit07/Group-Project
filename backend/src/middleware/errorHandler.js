// Catches errors passed via next(err) from any route/controller and
// returns a consistent JSON shape instead of leaking stack traces.
function errorHandler(err, req, res, next) {
  console.error(err);

  const status = err.status || 500;
  const message = status === 500 ? 'Something went wrong on the server.' : err.message;

  res.status(status).json({ message });
}

module.exports = errorHandler;
