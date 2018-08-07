const log = require('apify-shared/log');
const _ = require('underscore');
const { resolve } = require('url');
const vm = require('vm');
const Ajv = require('ajv');
const schema = require('../INPUT_SCHEMA.json');

exports.requestToRpOpts = (request) => {
    const opts = _.pick(request, 'url', 'method', 'headers');
    opts.body = request.payload;

    return opts;
};

exports.evalPageFunctionOrThrow = (funcString) => {
    let func;

    try {
        func = vm.runInNewContext(funcString, Object.create(null)); // "secure" the context by removing prototypes
    } catch (err) {
        log.exception(err, 'Cannot evaluate input parameter "pageFunction"!');
        throw err;
    }

    if (!_.isFunction(func)) throw new Error('Input parameter "pageFunction" is not a function!');

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

exports.checkInputOrThrow = (input) => {
    const ajv = new Ajv({ allErrors: true, useDefaults: true });
    const valid = ajv.validate(schema, input);
    if (!valid) throw new Error(`Invalid input:\n${ajv.errors}`);
};
