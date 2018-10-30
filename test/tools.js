const Apify = require('apify');
const { expect } = require('chai');
const tools = require('../src/tools');

describe('tools.requestToRpOpts()', () => {
    it('should work without body', () => {
        const given = tools.requestToRpOpts(new Apify.Request({
            url: 'http://example.com',
            method: 'GET',
            headers: {
                a: 'b',
                c: 'd',
            },
            userData: {
                foo: 'bar',
            },
        }));

        expect(given).to.be.eql({
            url: 'http://example.com',
            method: 'GET',
            headers: {
                a: 'b',
                c: 'd',
            },
            body: null,
        });
    });
    it('should work with body', () => {
        const given = tools.requestToRpOpts(new Apify.Request({
            url: 'http://example.com',
            method: 'POST',
            payload: '{ "foo": "bar" }',
            userData: {
                foo: 'bar',
            },
        }));

        expect(given).to.be.eql({
            url: 'http://example.com',
            method: 'POST',
            headers: {},
            body: '{ "foo": "bar" }',
        });
    });
});

describe('tools.evalCheerioFunctionOrThrow()', () => {
    // const test = (...args, result) =>
    //
    // it('should work without body', () => {
    //    expect(tools.evalCheerioFunctionOrThrow('(a, b) => c')(1, 2))
    // });
});
