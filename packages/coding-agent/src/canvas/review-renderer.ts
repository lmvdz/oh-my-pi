import { launchHeadlessBrowser, removeUserDataDir } from "../tools/browser/launch";

const REVIEW_VIEWPORT = { width: 1600, height: 1100, deviceScaleFactor: 1 };
const REVIEW_TIMEOUT_MS = 30_000;

/** Render the same Excalidraw page the user sees, fitted and stripped of editing controls for visual review. */
export async function renderCanvasReview(url: string, outputPath: string): Promise<void> {
	const reviewUrl = new URL(url);
	reviewUrl.searchParams.set("review", "1");
	const launched = await launchHeadlessBrowser({ headless: true, viewport: REVIEW_VIEWPORT });
	try {
		const page = await launched.browser.newPage();
		await page.goto(reviewUrl.href, { waitUntil: "networkidle2", timeout: REVIEW_TIMEOUT_MS });
		await page.waitForSelector(".excalidraw", { timeout: REVIEW_TIMEOUT_MS });
		await page.screenshot({ path: outputPath });
	} finally {
		await launched.browser.close();
		if (launched.userDataDir) await removeUserDataDir(launched.userDataDir);
	}
}
