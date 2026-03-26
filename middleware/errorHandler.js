export const errorHandler = (err, req, res, next) => {
  console.error("❌ ERROR:", err);
  
  res.status(err.status || 500).json({
    error: err.message || "InternalServerError",
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};

export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
