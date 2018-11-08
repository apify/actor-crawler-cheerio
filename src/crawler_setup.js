/* eslint-disable class-methods-use-this */
const Apify = require('apify');
const _ = require('underscore');
const tools = require('./tools');
const { getContextAndState } = require('./context');
const { META_KEY } = require('./consts');

const { utils: { log } } = Apify;


class CrawlerSetup {
    constructor(input) {
        // Validate INPUT if not running on Apify Cloud Platform.
        if (!Apify.isAtHome()) tools.checkInputOrThrow(input);

        this.rawInput = Object.assign({}, input);

        const {
            startUrls,
            pageFunction,
            proxyConfiguration,
            useRequestQueue,
            debugLog,
            ignoreSslErrors,
            linkSelector,
            maxRequestRetries,
            maxPagesPerCrawl,
            maxResultsPerCrawl,
            maxCrawlingDepth,
            pseudoUrls,
            minConcurrency,
            maxConcurrency,
            pageLoadTimeoutSecs,
            customData,
        } = input;

        // Validations
        if (pseudoUrls.length && !useRequestQueue) {
            throw new Error('Cannot enqueue links using Pseudo URLs without using a Request Queue. ' +
                'Either select the "Use Request Queue" option to enable Request Queue or ' +
                'remove your Pseudo URLs.');
        }

        // Side effects
        this.debugLog = debugLog;
        if (debugLog) log.setLevel(log.LEVELS.DEBUG);

        // Page Function needs to be evaluated.
        this.pageFunction = tools.evalPageFunctionOrThrow(pageFunction);
        // Pseudo URLs must be constructed first.
        this.pseudoUrls = pseudoUrls.map(item => new Apify.PseudoUrl(item.purl, _.omit(item, 'purl')));

        // Properties
        this.startUrls = startUrls;
        this.proxyConfiguration = proxyConfiguration;
        this.useRequestQueue = useRequestQueue;
        this.ignoreSslErrors = ignoreSslErrors;
        this.linkSelector = linkSelector;
        this.maxRequestRetries = maxRequestRetries;
        this.maxPagesPerCrawl = maxPagesPerCrawl;
        this.maxResultsPerCrawl = maxResultsPerCrawl;
        this.maxCrawlingDepth = maxCrawlingDepth;
        this.minConcurrency = minConcurrency;
        this.maxConcurrency = maxConcurrency;
        this.pageLoadTimeoutSecs = pageLoadTimeoutSecs;
        this.customData = customData;

        // Initialize async operations.
        this.crawler = null;
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

        // KeyValueStore
        this.keyValueStore = await Apify.openKeyValueStore();
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
            ...this.proxyConfiguration,
            handlePageFunction: this._getHandlePageFunction(env),
            requestList: this.requestList,
            requestQueue: this.requestQueue,
            // requestFunction: use default,
            // handlePageTimeoutSecs: use default,
            requestTimeoutSecs: this.pageLoadTimeoutSecs,
            ignoreSslErrors: this.ignoreSslErrors,
            handleFailedRequestFunction: this._getHandleFailedRequestFunction(),
            maxRequestRetries: this.maxRequestRetries,
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
            log.error(`Request ${request.id} failed ${this.maxRequestRetries + 1} times. Marking as failed.`);
            return this._handleResult(request, null, true);
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
        /**
         * This is the actual `handlePageFunction()` that gets passed
         * to `CheerioCrawler` constructor.
         */
        return async ({ $, html, request, response }) => {
            /**
             * PRE-PROCESSING
             */
            // Make sure that an object containing internal metadata
            // is present on every request.
            tools.ensureMetaData(request);

            // Abort the crawler if the maximum number of results was reached.
            const aborted = await this._handleMaxResultsPerCrawl();
            if (aborted) return;

            // Initialize context and state.
            const { context, state } = getContextAndState(this, { actorId, runId, request, response, html, $, log });

            /**
             * USER FUNCTION INVOCATION
             */
            const pageFunctionResult = await this.pageFunction(context);

            /**
             * POST-PROCESSING
             */
            // If the user invoked the `willFinishLater()` context function,
            // this prevents the internal `handlePageFunction` from returning until
            // the user calls the `finish()` context function.
            await this._handleWillFinishLater(state);

            // Enqueue more links if Pseudo URLs and a clickable selector are available,
            // unless the user invoked the `skipLinks()` context function
            // or maxCrawlingDepth would be exceeded.
            await this._handleLinks(state, request, $);

            // Save the `pageFunction`s result to the default dataset unless
            // the `skipOutput()` context function was invoked.
            if (state.skipOutput) return;
            await this._handleResult(request, pageFunctionResult);
        };
    }

    async _handleMaxResultsPerCrawl() {
        if (!this.maxResultsPerCrawl || this.pagesOutputted < this.maxResultsPerCrawl) return;
        log.info(`User set limit of ${this.maxResultsPerCrawl} results was reached. Finishing the crawl.`);
        await this.crawler.abort();
        return true;
    }

    async _handleWillFinishLater(state) {
        if (!state.finishPromise) return;
        log.debug('Waiting for context.finish() to be called!');
        await state.finishPromise;
    }

    async _handleLinks(state, request, $) {
        const currentDepth = request.userData[META_KEY].depth;
        const hasReachedMaxDepth = this.maxCrawlingDepth && currentDepth >= this.maxCrawlingDepth;
        if (hasReachedMaxDepth) {
            log.debug(`Request ${request.id} reached the maximum crawling depth of ${currentDepth}.`);
            return;
        }
        const canEnqueue = !state.skipLinks && this.pseudoUrls.length && this.linkSelector;
        if (canEnqueue && !hasReachedMaxDepth) {
            await tools.enqueueLinks(
                $,
                this.linkSelector,
                this.pseudoUrls,
                this.requestQueue,
                request,
            );
        }
    }

    async _handleResult(request, pageFunctionResult) {
        const payload = tools.createDatasetPayload(request, pageFunctionResult);
        await Apify.pushData(payload);
        this.pagesOutputted++;
    }
}

module.exports = CrawlerSetup;
