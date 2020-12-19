export class TimeoutError extends Error {}

export const sleep = function sleep(ms: number) {
	return new Promise(r => setTimeout(r, ms));
};
export const timeout = function timeout(ms: number) {
	return new Promise((resolve, reject) =>
		sleep(ms).then(() => reject(new TimeoutError()))
	);
};
