// Utility functions for human-like behavior

function randomDelay(min = 1000, max = 3000) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, delay));
}

function randomMouseMovement(page) {
    // Simulate random mouse movements (not visible in headless but adds to behavior)
    return page.mouse.move(
        Math.random() * 1920,
        Math.random() * 1080
    );
}

async function humanType(page, selector, text) {
    await page.click(selector);
    await randomDelay(100, 300);

    for (const char of text) {
        await page.type(selector, char, { delay: Math.random() * 100 + 50 });
    }
}

async function scrollPage(page) {
    await page.evaluate(() => {
        window.scrollBy(0, Math.random() * 500 + 200);
    });
    await randomDelay(500, 1000);
}

module.exports = {
    randomDelay,
    randomMouseMovement,
    humanType,
    scrollPage
};
