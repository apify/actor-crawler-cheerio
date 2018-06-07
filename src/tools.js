const log = require('apify-shared/log');
const _ = require('underscore');
const Promise = require('bluebird');
const { resolve } = require('url');

exports.requestToRpOpts = (request) => {
    const opts = _.pick(request, 'url', 'method', 'headers');
    opts.body = request.payload;

    return opts;
};

exports.evalCheerioFunctionOrThrow = (funcString) => {
    let func;

    try {
        func = eval(funcString); // eslint-disable-line
    } catch (err) {
        log.exception(err, 'Cannot evaluate input parameter "cheerioFunction"!');
        throw err;
    }

    if (!_.isFunction(func)) throw new Error('Input parameter "cheerioFunction" is not a function!');

    return func;
};

exports.enqueueLinks = async ($, selector, purls, requestQueue, parentUrl) => {
    const requests = [];

    $(selector).each((index, el) => {
        const pathOrUrl = $(el).attr('href');
        if (!pathOrUrl) return;

        const url = pathOrUrl.includes('://')
            ? pathOrUrl
            : resolve(parentUrl, pathOrUrl);

        purls
            .filter(purl => purl.matches(url))
            .forEach(purl => requests.push(purl.createRequest(url)));
    });

    return Promise.mapSeries(requests, request => requestQueue.addRequest(request));
};

exports.maybeParseJson = (maybeJson, paramName) => {
    if (!_.isString(maybeJson)) return maybeJson;

    try {
        return JSON.parse(maybeJson);
    } catch (err) {
        throw new Error(`Input parameter ${paramName} is not valid JSON: ${err}`);
    }
};
