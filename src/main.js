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
        pseudoUrls,
        sources,
    } = input;

    const {
        cheerioFunction,
        clickableElementsSelector = 'a',
    } = input;

    if (useRequestQueue === 'Yes') useRequestQueue = true;
    if (useRequestQueue === 'No') useRequestQueue = false;
    pseudoUrls = tools.maybeParseJson(pseudoUrls, 'pseudoUrls');
    sources = tools.maybeParseJson(sources, 'sources');

    if (!_.isArray(sources) || !sources.length) throw new Error('Input paremeter "sources" must contain at least one URL!');
    if (!_.isString(cheerioFunction) || !cheerioFunction) throw new Error('Input paremeter "cheerioFunction" is required!');
    if (!_.isBoolean(useRequestQueue)) throw new Error('Input parameter "useRequestQueue" must be a boolean!');
    if (!_.isString(clickableElementsSelector)) throw new Error('Input parameter "clickableElementsSelector" must be a string!');
    if (!_.isArray(pseudoUrls)) throw new Error('Input parameter "pseudoUrls" must be an pseudoUrls!');

    pseudoUrls.forEach((item, index) => {
        pseudoUrls[index] = new Apify.PseudoUrl(item.purl, item.requestTemplate);
    });

    const evaledCheerioFunction = tools.evalCheerioFunctionOrThrow(cheerioFunction);
    const crawlerOpts = {
        requestList: new Apify.RequestList({ sources }),

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

            const cheerioFunctionResult = await evaledCheerioFunction({
                request,
                html,
                requestList: crawlerOpts.requestList,
                requestQueue: crawlerOpts.requestQueue,
                $,
            });

            await Apify.pushData(Object.assign({}, request, { cheerioFunctionResult }));
        },
    };
    if (useRequestQueue) crawlerOpts.requestQueue = await Apify.openRequestQueue();
    await crawlerOpts.requestList.initialize();
    const crawler = new Apify.BasicCrawler(crawlerOpts);

    await crawler.run();
});
