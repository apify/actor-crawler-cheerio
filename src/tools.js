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
        func = vm.runInThisContext(funcString);
    } catch (err) {
        throw new Error(`Compilation of pageFunction failed.\n${err.stack.substr(err.stack.indexOf('\n'))}`);
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

    const requestOperationInfos = [];
    for (const request of requests) {
        requestOperationInfos.push(await requestQueue.addRequest(request));
    }
    return requestOperationInfos;
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
