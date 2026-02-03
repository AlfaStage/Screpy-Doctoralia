/**
 * Utility Helpers
 */

/**
 * Sleep function (Promise-based delay)
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Random delay between min and max milliseconds
 * @param {number} min - Minimum delay in ms
 * @param {number} max - Maximum delay in ms
 * @returns {Promise<void>}
 */
async function randomDelay(min = 1000, max = 3000) {
    const delay = min + Math.random() * (max - min);
    await sleep(delay);
}

module.exports = {
    sleep,
    randomDelay
};
