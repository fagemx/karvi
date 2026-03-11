async function retryOnConflict(fn, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err.code !== 'VERSION_CONFLICT' || attempt >= maxRetries) {
        throw err;
      }
      
      const delay = 50 * attempt;
      console.warn(`[retry] conflict on attempt ${attempt}/${maxRetries}, ` +
                   `retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

module.exports = { retryOnConflict };
