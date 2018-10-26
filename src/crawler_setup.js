const Apify = require('apify');
const tools = require('./tools');

const { utils: { log } } = Apify;

class CrawlerSetup {
    constructor(input) {
        this.rawInput = Object.assign({}, input);
        tools.checkInputOrThrow(input);
        Object.assign(this, input);
        this.pageFunction = tools.evalPageFunctionOrThrow(this.pageFunction);
    }

    async initialize() {
        if (this.verboseLog) log.isDebugMode = true;
        if (this.ignoreSslErrors) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        this.pseudoUrls.forEach((item, index) => {
            pseudoUrls[index] = new Apify.PseudoUrl(item.purl, item.requestTemplate);
        });
        const dataset = await Apify.openDataset();
        const { itemsCount } = await dataset.getInfo();
        this.pagesOutputted = itemsCount || 0;
    }

    getHandleFailedRequestFunction() { // eslint-disable-line
        return async ({ request }) => Apify.pushData(request);
    }

    getHandlePageFunction({ actId, runId, requestList, requestQueue }) {
        return async ({ $, html, request }) => {
            const state = {
                skipLinks: false,
                skipOutput: false,
                finishPromise: null,
                finishResolve: null,
            };

            const pageFunctionResult = await this.pageFunction({
                actId,
                runId,
                request,
                html,
                requestList,
                requestQueue,
                $,
                input: this.rawInput,
                client: Apify.client,
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
                    if (!this.useRequestQueue) {
                        log.warning('Input parameter "useRequestQueue" must be set to true to be able to enqueue new requests.');
                    }
                    if (!(request instanceof Apify.Request)) newRequest = new Apify.Request(newRequest);

                    return requestQueue.addRequest(newRequest);
                },
            });

            if (state.finishPromise) {
                log.debug('Waiting for context.finish() to be called!');
                await state.finishPromise;
            }

            if (!state.skipLinks && this.pseudoUrls.length && this.clickableElementsSelector) {
                if (!this.useRequestQueue) {
                    log.warning('Input parameter "useRequestQueue" must be set to true to be able to enqueue "pseudoUrls".');
                } else {
                    const requestOperationInfoArr = await tools.enqueueLinks(
                        $,
                        this.clickableElementsSelector,
                        this.pseudoUrls,
                        requestQueue,
                        request.url,
                    );

                    request.userData.childRequests = _.pluck(requestOperationInfoArr, 'requestId');
                }
            }

            if (!state.skipOutput) {
                await Apify.pushData(Object.assign({}, request, { pageFunctionResult }));
                this.pagesOutputted++;
            }
        };
    }
}

module.exports = CrawlerSetup;
