// Give a sort spec, which can be in any of these forms:
//   {"key1": 1, "key2": -1}
//   [["key1", "asc"], ["key2", "desc"]]
//   ["key1", ["key2", "desc"]]
//
// (.. with the first form being dependent on the key enumeration
// behavior of your javascript VM, which usually does what you mean in
// this case if the key names don't look like integers ..)
//
// return a function that takes two objects, and returns -1 if the
// first object comes first in order, 1 if the second object comes
// first, or 0 if neither object comes before the other.

Minimongo.Sorter = function (spec) {
  var self = this;

  self._sortSpecParts = [];

  var addSpecPart = function (path, ascending) {
    if (!path)
      throw Error("sort keys must be non-empty");
    if (path.charAt(0) === '$')
      throw Error("unsupported sort key: " + path);
    self._sortSpecParts.push({
      path: path,
      lookup: makeLookupFunction(path),
      ascending: ascending
    });
  };

  if (spec instanceof Array) {
    for (var i = 0; i < spec.length; i++) {
      if (typeof spec[i] === "string") {
        addSpecPart(spec[i], true);
      } else {
        addSpecPart(spec[i][0], spec[i][1] !== "desc");
      }
    }
  } else if (typeof spec === "object") {
    _.each(spec, function (value, key) {
      addSpecPart(key, value >= 0);
    });
  } else {
    throw Error("Bad sort specification: " + JSON.stringify(spec));
  }

  // To implement affectedByModifier, we piggy-back on top of Matcher's
  // affectedByModifier code; we create a selector that is affected by the same
  // modifiers as this sort order. This is only implemented on the server.
  if (self.affectedByModifier) {
    var selector = {};
    _.each(self._sortSpecParts, function (spec) {
      selector[spec.path] = 1;
    });
    self._selectorForAffectedByModifier = new Minimongo.Matcher(selector);
  }

  self._keyComparator = composeComparators(
    _.map(self._sortSpecParts, function (spec, i) {
      return self._keyFieldComparator(i);
    }));
};

// In addition to these methods, sorter_project.js defines combineIntoProjection
// on the server only.
_.extend(Minimongo.Sorter.prototype, {
  getComparator: function (options) {
    var self = this;

    // If we have no distances, just use the comparator from the source
    // specification (which defaults to "everything is equal".
    if (!options || !options.distances) {
      return self._getBaseComparator();
    }

    var distances = options.distances;

    // Return a comparator which first tries the sort specification, and if that
    // says "it's equal", breaks ties using $near distances.
    return composeComparators([self._getBaseComparator(), function (a, b) {
      if (!distances.has(a._id))
        throw Error("Missing distance for " + a._id);
      if (!distances.has(b._id))
        throw Error("Missing distance for " + b._id);
      return distances.get(a._id) - distances.get(b._id);
    }]);
  },

  _getPaths: function () {
    var self = this;
    return _.pluck(self._sortSpecParts, 'path');
  },

  // Finds the minimum key from the doc, according to the sort specs.  (We say
  // "minimum" here but this is with respect to the sort spec, so "descending"
  // sort fields mean we're finding the max for that field.)
  //
  // Note that this is NOT "find the minimum value of the first field, the
  // minimum value of the second field, etc"... it's "choose the
  // lexicographically minimum value of the key vector, allowing only keys which
  // you can find along the same paths".  ie, for a doc {a: [{x: 0, y: 5}, {x:
  // 1, y: 3}]} with sort spec {'a.x': 1, 'a.y': 1}, the only keys are [0,5] and
  // [1,3], and the minimum key is [0,5]; notably, [0,3] is NOT a key.
  _getMinKeyFromDoc: function (doc) {
    var self = this;
    var minKey = null;

    self._generateKeysFromDoc(doc, function (key) {
      // XXX This is actually wrong! In fact, the whole attempt to compile sort
      //     functions independently of selectors is wrong. In MongoDB, if you
      //     have documents {_id: 'x', a: [1, 10]} and {_id: 'y', a: [5, 15]},
      //     then C.find({}, {sort: {a: 1}}) puts x before y (1 comes before 5).
      //     But C.find({a: {$gt: 3}}, {sort: {a: 1}}) puts y before x (1 does
      //     not match the selector, and 5 comes before 10).
      //
      //     The way this works is pretty subtle!  For example, if the documents
      //     are instead {_id: 'x', a: [{x: 1}, {x: 10}]}) and
      //                 {_id: 'y', a: [{x: 5}, {x: 15}]}),
      //     then C.find({'a.x': {$gt: 3}}, {sort: {'a.x': 1}}) and
      //          C.find({a: {$elemMatch: {x: {$gt: 3}}}}, {sort: {'a.x': 1}})
      //     both follow this rule (y before x).  (ie, you do have to apply this
      //     through $elemMatch.)
      //
      //     So we ought to skip keys here that don't work for the selector, but
      //     we don't do that yet.

      if (minKey === null) {
        minKey = key;
        return;
      }
      if (self._compareKeys(key, minKey) < 0) {
        minKey = key;
      }
    });

    if (minKey === null)
      throw Error("sort selector found no keys in doc?");
    return minKey;
  },

  // Iterates over each possible "key" from doc (ie, over each branch), calling
  // 'cb' with the key.
  _generateKeysFromDoc: function (doc, cb) {
    var self = this;

    if (self._sortSpecParts.length === 0)
      throw new Error("can't generate keys without a spec");

    // maps index -> ({'' -> value} or {path -> value})
    var valuesByIndexAndPath = [];

    var pathFromIndices = function (indices) {
      return indices.join(',') + ',';
    };

    var knownPaths = null;

    _.each(self._sortSpecParts, function (spec, whichField) {
      // Expand any leaf arrays that we find, and ignore those arrays
      // themselves.  (We never sort based on an array itself.)
      var branches = expandArraysInBranches(spec.lookup(doc), true);

      // If there are no values for a key (eg, key goes to an empty array),
      // pretend we found one null value.
      if (!branches.length)
        branches = [{value: null}];

      var usedPaths = false;
      valuesByIndexAndPath[whichField] = {};
      _.each(branches, function (branch) {
        if (!branch.arrayIndices) {
          // If there are no array indices for a branch, then it must be the
          // only branch, because the only thing that produces multiple branches
          // is the use of arrays.
          if (branches.length > 1)
            throw Error("multiple branches but no array used?");
          valuesByIndexAndPath[whichField][''] = branch.value;
          return;
        }

        usedPaths = true;
        var path = pathFromIndices(branch.arrayIndices);
        if (_.has(valuesByIndexAndPath[whichField], path))
          throw Error("duplicate path: " + path);
        valuesByIndexAndPath[whichField][path] = branch.value;

        // If two sort fields both go into arrays, they have to go into the
        // exact same arrays and we have to find the same paths.  This is
        // roughly the same condition that makes MongoDB throw this strange
        // error message.  eg, the main thing is that if sort spec is {a: 1,
        // b:1} then a and b cannot both be arrays.
        //
        // (In MongoDB it seems to be OK to have {a: 1, 'a.x.y': 1} where 'a'
        // and 'a.x.y' are both arrays, but we don't allow this for now.
        // #NestedArraySort
        // XXX achieve full compatibility here
        if (knownPaths && !_.has(knownPaths, path)) {
          throw Error("cannot index parallel arrays");
        }
      });

      if (knownPaths) {
        // Similarly to above, paths must match everywhere, unless this is a
        // non-array field.
        if (!_.has(valuesByIndexAndPath[whichField], '') &&
            _.size(knownPaths) !== _.size(valuesByIndexAndPath[whichField])) {
          throw Error("cannot index parallel arrays!");
        }
      } else if (usedPaths) {
        knownPaths = {};
        _.each(valuesByIndexAndPath[whichField], function (x, path) {
          knownPaths[path] = true;
        });
      }
    });

    if (!knownPaths) {
      // Easy case: no use of arrays.
      var soleKey = _.map(valuesByIndexAndPath, function (values) {
        if (!_.has(values, ''))
          throw Error("no value in sole key case?");
        return values[''];
      });
      cb(soleKey);
      return;
    }

    _.each(knownPaths, function (x, path) {
      var key = _.map(valuesByIndexAndPath, function (values) {
        if (_.has(values, ''))
          return values[''];
        if (!_.has(values, path))
          throw Error("missing path?");
        return values[path];
      });
      cb(key);
    });
  },

  // Takes in two keys: arrays whose lengths match the number of spec
  // parts. Returns negative, 0, or positive based on using the sort spec to
  // compare fields.
  _compareKeys: function (key1, key2) {
    var self = this;
    if (key1.length !== self._sortSpecParts.length ||
        key2.length !== self._sortSpecParts.length) {
      throw Error("Key has wrong length");
    }

    return self._keyComparator(key1, key2);
  },

  // Given an index 'i', returns a comparator that compares two key arrays based
  // on field 'i'.
  _keyFieldComparator: function (i) {
    var self = this;
    var invert = !self._sortSpecParts[i].ascending;
    return function (key1, key2) {
      var compare = LocalCollection._f._cmp(key1[i], key2[i]);
      if (invert)
        compare = -compare;
      return compare;
    };
  },

  // Returns a comparator that represents the sort specification (but not
  // including a possible geoquery distance tie-breaker).
  _getBaseComparator: function () {
    var self = this;

    // If we're only sorting on geoquery distance and no specs, just say
    // everything is equal.
    if (!self._sortSpecParts.length) {
      return function (doc1, doc2) {
        return 0;
      };
    }

    return function (doc1, doc2) {
      var key1 = self._getMinKeyFromDoc(doc1);
      var key2 = self._getMinKeyFromDoc(doc2);
      return self._compareKeys(key1, key2);
    };
  }
});

// Given an array of comparators
// (functions (a,b)->(negative or positive or zero)), returns a single
// comparator which uses each comparator in order and returns the first
// non-zero value.
var composeComparators = function (comparatorArray) {
  return function (a, b) {
    for (var i = 0; i < comparatorArray.length; ++i) {
      var compare = comparatorArray[i](a, b);
      if (compare !== 0)
        return compare;
    }
    return 0;
  };
};
