const { utils: { log } } = require('apify');

exports.createContextFunctions = (crawlerSetup, state) => {
    return {
        skipLinks: () => {
            log.debug('Skipping links.');
            state.skipLinks = true;
        },
        skipOutput: () => {
            log.debug('Skipping output.');
            state.skipOutput = true;
        },
        willFinishLater: () => {
            log.debug('context.willFinishLater() called');
            state.finishPromise = new Promise((resolve, reject) => {
                state.finishResolve = resolve;
                state.finishReject = reject;
            });
        },
        finish: (err) => {
            if (!state.finishResolve) {
                throw new Error('context.willFinishLater() must be called before context.finish()!');
            }
            log.debug('context.finish() called');
            if (err) state.finishReject(err);
            else state.finishResolve();
        },
        enqueuePage: (newRequest) => {
            if (!crawlerSetup.useRequestQueue) {
                throw new Error('Input parameter "useRequestQueue" must be set to true to be able to enqueue new requests.');
            }
            return crawlerSetup.requestQueue.addRequest(newRequest);
        },
    };
};
