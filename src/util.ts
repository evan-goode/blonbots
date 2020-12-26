export class TimeoutError extends Error {}

export const sleep = function sleep(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms));
};

export const timeout = function timeout(ms: number) {
	return new Promise((resolve, reject) =>
		sleep(ms).then(() => reject(new TimeoutError()))
	);
};

export const isPending = function isPending(p: Promise<any>) {
	const t = {};
	return Promise.race([p, t]).then(v => (v === t));
};
