const Apify = require('apify');
const _ = require('underscore');
const { ENV_VARS } = require('apify-shared/consts');
const CrawlerSetup = require('./crawler_setup');

const { utils: { log } } = Apify;

log.logJson = false;

Apify.main(async () => {
    const input = await Apify.getValue('INPUT');
    if (!input) throw new Error('INPUT cannot be empty!');

    const setup = new CrawlerSetup(input);
    await setup.initialize();

    const actId = process.env[ENV_VARS.ACT_ID];
    const runId = process.env[ENV_VARS.ACT_RUN_ID];

    const requestList = new Apify.RequestList({ sources: setup.startUrls });
    await requestList.initialize();

    let requestQueue;
    if (setup.useRequestQueue) requestQueue = await Apify.openRequestQueue();

    const pageFunctionContext = { actId, runId, requestList, requestQueue };

    const crawlerOpts = {
        requestList,
        requestQueue,
        maxRequestsPerCrawl: setup.maxPagesPerCrawl,
        handleFailedRequestFunction: setup.getHandleFailedRequestFunction(),
        handlePageFunction: setup.getHandlePageFunction(pageFunctionContext),
    };

    const crawler = new Apify.CheerioCrawler(crawlerOpts);
    await crawler.run();
    log.info('Crawler finished.');
});
