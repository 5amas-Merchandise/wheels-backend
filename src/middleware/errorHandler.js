function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  const payload = {
    error: {
      message: err.message || 'Internal Server Error'
    }
  };
  if (process.env.NODE_ENV === 'development') {
    payload.error.stack = err.stack;
  }
  res.status(status).json(payload);
}

module.exports = errorHandler;
