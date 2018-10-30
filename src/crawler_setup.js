const Apify = require('apify');
const _ = require('underscore');
const tools = require('./tools');
const { createContextFunctions } = require('./context_functions');

const { utils: { log } } = Apify;

class CrawlerSetup {
    constructor(input) {
        // Validate INPUT if not running on Apify Cloud Platform.
        if (!Apify.isAtHome()) tools.checkInputOrThrow(input);

        this.rawInput = Object.assign({}, input);

        const {
            startUrls,
            pageFunction,
            useRequestQueue,
            verboseLog,
            ignoreSslErrors,
            clickableElementsSelector,
            maxPagesPerCrawl,
            pseudoUrls,
            minConcurrency,
            maxConcurrency,
        } = input;

        // Validations
        if (pseudoUrls.length && !useRequestQueue) {
            throw new Error('Cannot enqueue links using Pseudo URLs without using a Request Queue. ' +
                'Either select the "Use Request Queue" option to enable Request Queue or ' +
                'remove your Pseudo URLs.');
        }

        // Side effects
        this.verboseLog = verboseLog;
        if (verboseLog) log.setLevel(log.LEVELS.DEBUG);

        // Page Function needs to be evaluated.
        this.pageFunction = tools.evalPageFunctionOrThrow(pageFunction);
        // Pseudo URLs must be constructed first.
        this.pseudoUrls = pseudoUrls.map(item => new Apify.PseudoUrl(item.purl, _.omit(item, 'purl')));

        // Simple properties
        this.startUrls = startUrls;
        this.useRequestQueue = useRequestQueue;
        this.ignoreSslErrors = ignoreSslErrors;
        this.clickableElementsSelector = clickableElementsSelector;
        this.maxPagesPerCrawl = maxPagesPerCrawl;
        this.minConcurrency = minConcurrency;
        this.maxConcurrency = maxConcurrency;

        // Initialize async operations.
        this.requestList = null;
        this.requestQueue = null;
        this.dataset = null;
        this.initPromise = this._initializeAsync();
    }

    async _initializeAsync() {
        // RequestList
        this.requestList = new Apify.RequestList({ sources: this.startUrls });
        await this.requestList.initialize();

        // RequestQueue if selected
        if (this.useRequestQueue) this.requestQueue = await Apify.openRequestQueue();

        // Dataset
        this.dataset = await Apify.openDataset();
        const { itemsCount } = await this.dataset.getInfo();
        this.pagesOutputted = itemsCount || 0;
    }

    /**
     * Resolves to an options object that may be directly passed to a `CheerioCrawler`
     * constructor.
     * @param {Object} env
     * @returns {Promise<Object>}
     */
    async getOptions(env) {
        await this.initPromise;

        return {
            handlePageFunction: this._getHandlePageFunction(env),
            requestList: this.requestList,
            requestQueue: this.requestQueue,
            // requestFunction: use default,
            // handlePageTimeoutSecs: use default,
            // requestTimeoutSecs: use default,
            ignoreSslErrors: this.ignoreSslErrors,
            handleFailedRequestFunction: this._getHandleFailedRequestFunction(),
            // maxRequestRetries: use default,
            maxRequestsPerCrawl: this.maxPagesPerCrawl,
            autoscaledPoolOptions: {
                minConcurrency: this.minConcurrency,
                maxConcurrency: this.maxConcurrency,
                systemStatusOptions: {
                    // Cheerio does a lot of sync operations, so we need to
                    // give it some time to do its job.
                    maxEventLoopOverloadedRatio: 0.8,
                },
            },
        };
    }

    _getHandleFailedRequestFunction() { // eslint-disable-line class-methods-use-this
        return async ({ request }) => {
            log.error(`Request ${request.id} failed.`);
            return Apify.pushData(request);
        };
    }

    /**
     * Factory that creates a `handlePageFunction` to be used in the `CheerioCrawler`
     * class.
     *
     * First of all, it initializes the state that is exposed to the user via
     * `pageFunction` context and then it constructs all the context's functions to
     * avoid unnecessary operations with each `pageFunction` call.
     *
     * Then it invokes the user provided `pageFunction` with the prescribed context
     * and saves it's return value.
     *
     * Finally, it makes decisions based on the current state and post-processes
     * the data returned from the `pageFunction`.
     * @param {Object} environment
     * @returns {Function}
     */
    _getHandlePageFunction({ actorId, runId }) {
        const state = {
            skipLinks: false,
            skipOutput: false,
            finishPromise: null,
            finishResolve: null,
        };

        const {
            skipLinks,
            skipOutput,
            willFinishLater,
            finish,
            enqueuePage,
        } = createContextFunctions(this, state);

        return async ({ $, html, request, response }) => {
            const pageFunctionResult = await this.pageFunction({
                actorId,
                runId,
                request,
                response,
                html,
                requestList: this.requestList,
                requestQueue: this.requestQueue,
                $,
                input: this.rawInput,
                client: Apify.client,
                skipLinks,
                skipOutput,
                willFinishLater,
                finish,
                enqueuePage,
            });

            // If the user invoked the `willFinishLater()` context function,
            // this prevents the internal `handlePageFunction` from returning until
            // the user calls the `finish()` context function.
            if (state.finishPromise) {
                log.debug('Waiting for context.finish() to be called!');
                await state.finishPromise;
            }

            // Enqueue more links if Pseudo URLs and a clickable selector are available,
            // unless the user invoked the `skipLinks()` context function.
            if (!state.skipLinks && this.pseudoUrls.length && this.clickableElementsSelector) {
                const requestOperationInfoArr = await tools.enqueueLinks(
                    $,
                    this.clickableElementsSelector,
                    this.pseudoUrls,
                    this.requestQueue,
                    request.url,
                );
                // Save the ids of enqueued requests to the parent requests for easier tracking.
                // TODO perhaps move this away from userData to prevent polluting users namespace
                request.userData.childRequests = requestOperationInfoArr.map(op => op.requestId);
            }

            // Save the `pageFunction`s result to the default dataset unless
            // the `skipOutput()` context function was invoked.
            if (!state.skipOutput) {
                await Apify.pushData(Object.assign({}, request, { pageFunctionResult }));
                this.pagesOutputted++;
            }
        };
    }
}

module.exports = CrawlerSetup;
