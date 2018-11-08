const Apify = require('apify');
const _ = require('underscore');
const { resolve } = require('url');
const vm = require('vm');
const Ajv = require('ajv');

const { META_KEY } = require('./consts');
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

exports.enqueueLinks = async ($, selector, purls, requestQueue, parentRequest) => {
    const requests = [];

    $(selector).each((index, el) => {
        const pathOrUrl = $(el).attr('href');
        if (!pathOrUrl) return;

        const url = pathOrUrl.includes('://')
            ? pathOrUrl
            : resolve(parentRequest.url, pathOrUrl);

        purls
            .filter(purl => purl.matches(url))
            .forEach(purl => requests.push(purl.createRequest(url)));
    });

    const requestOperationInfos = [];
    for (const request of requests) {
        // When parent has no depth, it must be the first one.
        const parentDepth = parentRequest.userData[META_KEY].depth || 0;

        // Since constructor does not support custom parameters,
        // we need to attach the metadata later.
        const newRequest = new Apify.Request(request);
        newRequest.userData[META_KEY] = {
            depth: parentDepth + 1,
            parent: parentRequest.id,
            children: [],
        };
        // Enqueue the new request.
        requestOperationInfos.push(await requestQueue.addRequest(newRequest));
        // Add it to its parent's list.
        parentRequest.userData[META_KEY].children[newRequest.id] = 1;
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
    if (!valid) throw new Error(`Invalid input:\n${JSON.stringify(ajv.errors, null, 2)}`);
};

exports.ensureMetaData = ({ id, userData }) => {
    const metadata = userData[META_KEY];
    if (!metadata) {
        userData[META_KEY] = {
            depth: 0,
            parent: null,
            children: {},
        };
        return;
    }
    if (typeof metadata !== 'object') throw new Error(`Request ${id} contains invalid metadata value.`);
};

/**
 * Merges the result of the page function, that may be a single object
 * or an array objects, with request metadata and a flag, whether
 * an error occured. This would typically be used after the page
 * had been retried and the handleFailedRequestFunction was called.
 *
 * If an Object[] is returned from the page function, each of the objects
 * will have the metadata appended for consistency, since the dataset
 * will flatten the results.
 *
 * @param {Request} request
 * @param {Object|Object[]} pageFunctionResult
 * @param {Boolean} [isError]
 * @returns {Object[]}
 */
exports.createDatasetPayload = (request, pageFunctionResult, isError = false) => {
    // Null and undefined do not prevent the payload
    // from being saved to dataset. It will just contain
    // the relevant metadata.
    let result = pageFunctionResult || {};

    // Validate the result.
    const type = typeof result;
    if (type !== 'object') {
        throw new Error(`Page function must return Object | Object[], but it returned ${type}.`);
    }

    // Metadata need to be appended to each item
    // to match results with dataset "lines".
    if (!Array.isArray(result)) result = [result];
    const meta = {
        '#error': isError,
        '#debug': _.pick(request, ['url', 'method', 'retryCount', 'errorMessages']),
    };
    meta['#debug'].requestId = request.id;

    return result.map(item => Object.assign({}, item, meta));
};
