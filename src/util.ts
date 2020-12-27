export class TimeoutError extends Error {}

export const TPS = 20;
export const HIDE_MESSAGE = "🚫";

export const sleep = function sleep(seconds: number): Promise<void> {
	return new Promise((r) => setTimeout(r, 1000 * seconds));
};

export const timeout = function timeout(ms: number) {
	return new Promise((resolve, reject) =>
		sleep(ms).then(() => reject(new TimeoutError()))
	);
};

export const isPending = function isPending(p: Promise<any>) {
	const t = {};
	return Promise.race([p, t]).then((v) => v === t);
};

interface FindResult {
	item: any;
	index: number;
}
