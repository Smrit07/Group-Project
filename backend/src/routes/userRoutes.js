// This is a deliberately simple stand-in formula, NOT the DES model.
// The real wait-time prediction is produced by the SimPy engine in
// /des-engine (see that folder's README). This function exists purely
// so the API still returns a usable estimate if that service is down —
// satisfying NFR-09 ("system shall still show the live queue length
// rather than failing completely").
//
// Assumption: on average one student is served roughly every
// AVG_SERVICE_TIME_MINUTES per open counter.
const AVG_SERVICE_TIME_MINUTES = 2.5;

function estimateWaitMinutes(queueLength, openCounters) {
  if (!openCounters || openCounters <= 0) {
    // No counters open — cannot estimate a meaningful wait.
    return null;
  }
  const estimate = (queueLength / openCounters) * AVG_SERVICE_TIME_MINUTES;
  return Math.round(estimate * 10) / 10; // one decimal place
}

module.exports = { estimateWaitMinutes };
