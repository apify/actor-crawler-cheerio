const Apify = require('apify');
const rp = require('request-promise');
const _ = require('underscore');
const cheerio = require('cheerio');
const log = require('apify-shared/log');
const tools = require('./tools');

log.logJson = false;

Apify.main(async () => {
    const input = await Apify.getValue('INPUT');
    if (!input) throw new Error('INPUT cannot be empty!');

    let {
        useRequestQueue,
        startUrls,
        pseudoUrls,
    } = input;

    const {
        pageFunction,
        clickableElementsSelector = 'a',
    } = input;

    if (useRequestQueue === 'Yes') useRequestQueue = true;
    if (useRequestQueue === 'No') useRequestQueue = false;
    startUrls = tools.maybeParseJson(startUrls, 'startUrls');
    pseudoUrls = tools.maybeParseJson(pseudoUrls, 'pseudoUrls');

    if (!_.isArray(startUrls) || !startUrls.length) throw new Error('Input paremeter "startUrls" must contain at least one URL!');
    if (!_.isString(pageFunction) || !pageFunction) throw new Error('Input paremeter "pageFunction" is required!');
    if (!_.isBoolean(useRequestQueue)) throw new Error('Input parameter "useRequestQueue" must be a boolean!');
    if (!_.isString(clickableElementsSelector)) throw new Error('Input parameter "clickableElementsSelector" must be a string!');
    if (!_.isArray(pseudoUrls)) throw new Error('Input parameter "pseudoUrls" must be an pseudoUrls!');

    pseudoUrls.forEach((item, index) => {
        pseudoUrls[index] = new Apify.PseudoUrl(item.purl, item.requestTemplate);
    });

    const evaledPageFunction = tools.evalPageFunctionOrThrow(pageFunction);
    const crawlerOpts = {
        requestList: new Apify.RequestList({ sources: startUrls }),

        handleFailedRequestFunction: async ({ request }) => {
            await Apify.pushData(request);
        },

        handleRequestFunction: async ({ request }) => {
            const html = await rp(tools.requestToRpOpts(request));
            const $ = cheerio.load(html);

            if (pseudoUrls.length && clickableElementsSelector) {
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

            const pageFunctionResult = await evaledPageFunction({
                request,
                html,
                requestList: crawlerOpts.requestList,
                requestQueue: crawlerOpts.requestQueue,
                $,
            });

            await Apify.pushData(Object.assign({}, request, { pageFunctionResult }));
        },
    };
    if (useRequestQueue) crawlerOpts.requestQueue = await Apify.openRequestQueue();
    await crawlerOpts.requestList.initialize();
    const crawler = new Apify.BasicCrawler(crawlerOpts);

    await crawler.run();
});
