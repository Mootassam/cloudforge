'use strict';
// Shared singletons used across routes.
const { createQueue } = require('./queue');
// Max heavy builds running at once. 2 is safe for Oracle free (4 CPU / 24 GB).
const deployQueue = createQueue(Number(process.env.CF_MAX_BUILDS) || 2);
module.exports = { deployQueue };
