const Apify = require('apify');
const rp = require('request-promise');
const _ = require('underscore');
const cheerio = require('cheerio');
const log = require('apify-shared/log');
const { ENV_VARS } = require('apify-shared/consts');
const tools = require('./tools');

log.logJson = false;

Apify.main(async () => {
    const input = await Apify.getValue('INPUT');
    if (!input) throw new Error('INPUT cannot be empty!');

    let {
        useRequestQueue = false,
        disableWebSecurity = false,
        verboseLog = false,
        startUrls,
        pseudoUrls,
    } = input;

    const {
        pageFunction,
        clickableElementsSelector = 'a',
        maxPagesPerCrawl,
    } = input;

    if (useRequestQueue === 'Yes') useRequestQueue = true;
    if (useRequestQueue === 'No') useRequestQueue = false;
    if (verboseLog === 'Yes') verboseLog = true;
    if (verboseLog === 'No') verboseLog = false;
    if (disableWebSecurity === 'Yes') disableWebSecurity = true;
    if (disableWebSecurity === 'No') disableWebSecurity = false;
    startUrls = tools.maybeParseJson(startUrls, 'startUrls');
    pseudoUrls = tools.maybeParseJson(pseudoUrls, 'pseudoUrls');

    if (!_.isArray(startUrls) || !startUrls.length) throw new Error('Input parameter "startUrls" must contain at least one URL!');
    if (!_.isString(pageFunction) || !pageFunction) throw new Error('Input parameter "pageFunction" is required!');
    if (!_.isBoolean(useRequestQueue)) throw new Error('Input parameter "useRequestQueue" must be a boolean!');
    if (!_.isBoolean(verboseLog)) throw new Error('Input parameter "verboseLog" must be a boolean!');
    if (!_.isBoolean(disableWebSecurity)) throw new Error('Input parameter "disableWebSecurity" must be a boolean!');
    if (!_.isString(clickableElementsSelector)) throw new Error('Input parameter "clickableElementsSelector" must be a string!');
    if (!_.isArray(pseudoUrls)) throw new Error('Input parameter "pseudoUrls" must be an pseudoUrls!');
    if (!_.isNumber(maxPagesPerCrawl)) throw new Error('Input parameter "maxPagesPerCrawl" must be a number!');

    if (verboseLog) log.isDebugMode = true;
    if (disableWebSecurity) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    pseudoUrls.forEach((item, index) => {
        pseudoUrls[index] = new Apify.PseudoUrl(item.purl, item.requestTemplate);
    });

    const actId = process.env[ENV_VARS.ACT_ID];
    const runId = process.env[ENV_VARS.ACT_RUN_ID];

    const evaledPageFunction = tools.evalPageFunctionOrThrow(pageFunction);
    const crawlerOpts = {
        requestList: new Apify.RequestList({ sources: startUrls }),
        maxRequestsPerCrawl: maxPagesPerCrawl,

        handleFailedRequestFunction: async ({ request }) => {
            await Apify.pushData(request);
        },

        handleRequestFunction: async ({ request }) => {
            const html = await rp(tools.requestToRpOpts(request));
            const $ = cheerio.load(html);

            const state = {
                skipLinks: false,
                skipOutput: false,
                finishPromise: null,
                finishResolve: null,
            };

            const pageFunctionResult = await evaledPageFunction({
                actId,
                runId,
                request,
                html,
                requestList: crawlerOpts.requestList,
                requestQueue: crawlerOpts.requestQueue,
                $,
                input,
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
                    if (!useRequestQueue) {
                        log.warning('Input parameter "useRequestQueue" must be set to true to be able to enqueue new requests.');
                    }
                    if (!(request instanceof Apify.Request)) newRequest = new Apify.Request(newRequest);

                    return crawlerOpts.requestQueue.addRequest(newRequest);
                },
            });

            if (state.finishPromise) {
                log.debug('Waiting for context.finish() to be called!');
                await state.finishPromise;
            }

            if (!state.skipLinks && pseudoUrls.length && clickableElementsSelector) {
                if (!useRequestQueue) {
                    log.warning('Input parameter "useRequestQueue" must be set to true to be able to enqueue "pseudoUrls".');
                } else {
                    const requestOperationInfoArr = await tools.enqueueLinks(
                        $,
                        clickableElementsSelector,
                        pseudoUrls,
                        crawlerOpts.requestQueue,
                        request.url,
                    );

                    request.userData.childRequests = _.pluck(requestOperationInfoArr, 'requestId')
                }
            }

            if (!state.skipOutput) {
                await Apify.pushData(Object.assign({}, request, { pageFunctionResult }));
            }
        },
    };
    if (useRequestQueue) crawlerOpts.requestQueue = await Apify.openRequestQueue();
    await crawlerOpts.requestList.initialize();
    const crawler = new Apify.BasicCrawler(crawlerOpts);

    await crawler.run();
    log.info('Crawler finished.');
});
