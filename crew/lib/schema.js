'use strict';
// A small JSON Schema validator — enough of draft-07 for the crew's four contracts, and
// nothing else. Zero dependencies is a hard requirement: the crew has to run on a marker's
// machine with `node run-crew.js --stub` and no install step.
//
// Supported: type, enum, const, required, properties, additionalProperties (false only),
// patternProperties, items, minItems, maxItems, minimum, maximum, exclusiveMinimum,
// minLength, pattern, uniqueItems.
//
// This is a deterministic gate. It runs between every agent handoff, and a schema failure
// retries the agent rather than letting a malformed artifact reach the next one — the
// difference between a crew that crashes on stage three and one that reports what went
// wrong on stage two.

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeMatches(value, expected) {
  const actual = typeOf(value);
  const list = Array.isArray(expected) ? expected : [expected];
  return list.some((t) => (t === 'number' ? actual === 'number' || actual === 'integer' : actual === t));
}

// -> array of human-readable error strings; empty means valid.
function validate(value, schema, path = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;

  if (schema.type !== undefined && !typeMatches(value, schema.type)) {
    const want = Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type;
    errors.push(`${path}: expected ${want}, got ${typeOf(value)}`);
    return errors; // every further check would be noise
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected the constant ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  }

  const t = typeOf(value);

  if (t === 'number' || t === 'integer') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: ${value} is below the minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: ${value} is above the maximum ${schema.maximum}`);
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      errors.push(`${path}: ${value} must be greater than ${schema.exclusiveMinimum}`);
    }
  }

  if (t === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: string is shorter than ${schema.minLength} characters`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
    }
  }

  if (t === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: has ${value.length} items, needs at least ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: has ${value.length} items, allows at most ${schema.maxItems}`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set();
      value.forEach((item, i) => {
        const k = JSON.stringify(item);
        if (seen.has(k)) errors.push(`${path}[${i}]: duplicate item`);
        seen.add(k);
      });
    }
    if (schema.items) {
      value.forEach((item, i) => errors.push(...validate(item, schema.items, `${path}[${i}]`)));
    }
  }

  if (t === 'object') {
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${path}: missing required property "${key}"`);
      }
    }
    const props = schema.properties || {};
    const patterns = Object.entries(schema.patternProperties || {}).map(([p, s]) => [new RegExp(p), s]);

    for (const [key, v] of Object.entries(value)) {
      const child = `${path}.${key}`;
      if (props[key]) {
        errors.push(...validate(v, props[key], child));
        continue;
      }
      const matched = patterns.find(([re]) => re.test(key));
      if (matched) {
        errors.push(...validate(v, matched[1], child));
        continue;
      }
      if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${key}"`);
      }
    }
  }

  return errors;
}

module.exports = { validate };
