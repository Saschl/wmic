"use strict";

/*
  wmic calls must always be serialised in windows, hence the use of async.queue
*/

var spawn = require('child_process').spawn,
    exec  = require('child_process').exec,
    async = require('async'),
    fs    = require('fs'),
    iconv = require('iconv-lite');

/**
 * Need to split a command line string taking into account strings - that is, don't
 * split spaces within a string. So that 'P1 P2 "Other Param" P4' is split into 4 param strings
 * with param 3 = "Other Param" (not including quotes).
 **/
function splitter(cmd) {
  cmd = cmd.trim();

  var acc = [], inString = false, cur = "", l = cmd.length;

  for (var i = 0 ; i < l ; i++ ){
    var ch = cmd.charAt(i);
    switch(ch) {
    case '"':
      inString = !inString;
      if (!inString) {
        if (cur.length > 0) {
          acc.push(cur);
          cur = "";
        }
      }
      break;
    case ' ':
      if (inString) {
        cur += ' ';
      } else {
        if (cur.length > 0) {
          acc.push(cur);
          cur = "";
        }
      }
      break;
    default:
      cur += ch;
      break;
    }
  }

  if (cur.length > 0) acc.push(cur);
  return acc;
};


function parse_list(data){

  var list = [];

  var blocks = data.split(/\n\n|\n,?\r/g).filter(function(block) {
    return block.length > 2;
  });

  blocks.forEach(function(block) {
    var obj   = {};
    var lines = block.split(/\n+|\r+/).filter(function(line) {
      return line.indexOf('=') !== -1
    });

    lines.forEach(function(line) {
      var kv = line.replace(/^,/, '').split("=");
      obj[kv[0]] = kv[1];
    })

    if (Object.keys(obj).length > 0)
      list.push(obj);
  })

  return list;
}

function parse_values(out){

  var arr  = [],
      data = buildDataArray(out),
      keys = data[0];

  data.forEach(function(k, i){
    if(k != keys){
      var obj = {};

      k.forEach(function(l, j){
        obj[keys[j]] = l
      })

      arr.push(obj);
    }
  });

  return arr;
}

function buildDataArray(rawInput){
  var lines = rawInput.toString().trim().split('\n'),
      data = [],
      keys = [],
      linePattern = /(\S*?\s\s+)/g,
      match;

  while ((match = linePattern.exec(lines[0])) !== null) {
    if (match.index === linePattern.lastIndex) {
        linePattern.lastIndex++;
    }

    var key = {};

    key.string = match[0].trim();
    key.startPoint = lines[0].indexOf(key.string);
    key.keyLength = match[0].length;

    keys.push(key);
  }

  lines.forEach(function(line, index){
    var lineData = [];

    keys.forEach(function(key, jndex){
      lineData.push(line.substr(key.startPoint, key.keyLength).trim());
    })

    data.push(lineData);
  })

  return data;
}

/**
 * Run the wmic command provided.
 *
 * The resulting output string has an additional pid property added so, one may get the process
 * details. This seems the easiest way of doing so given the run is in a queue.
 **/
var run = exports.run = function run(cmd, cb) {
  queue.push(cmd, cb);
};

// The encoding is cached in this variable, so the CHCP command is executed only once.
var consoleEncoding;

var queue = async.queue(function(cmd, cb) {

  var opts = { env: process.env, cwd: process.env.TEMP };
  if (opts.env.PATH.indexOf('system32') === -1) {
    opts.env.PATH += ';' + process.env.WINDIR + "\\system32";
    opts.env.PATH += ';' + process.env.WINDIR + "\\system32\\wbem";
  }

  var pid;

  async.parallel([
      function(cb) {
        if (consoleEncoding) {
          cb(null, consoleEncoding);
        } else {
          exec('chcp', function(err, stdout) {
            if (err) {
              cb(err);
              return;
            }
            var codePage = stdout.replace(/\D/g, '');
            consoleEncoding = codePage && codePage !== '65001' ? 'cp' + codePage : 'utf8';
            cb(null, consoleEncoding);
          });
        }
      },
      function(cb) {
        var wm = spawn('wmic', splitter(cmd), opts),
          stdout = [],
          stderr = [];

        pid = wm.pid;

        wm.on('error', function(e) {
          if (e.code == 'ENOENT')
            e.message = 'Unable to find wmic command in path.';

          cb(e);
        })

        wm.stdout.on('data', function(d) {
          // console.log('Got out: ' + d.toString())
          stdout.push(d);
        });

        wm.stderr.on('data', function(e) {
          // console.log('Got error: ' + e.toString())
          stderr.push(e);
        });

        wm.on('exit', function(code) {
          // remove weird temp file generated by wmic
          fs.unlink('TempWmicBatchFile.bat', function() { /* noop */ });

          setImmediate(function() {
            cb(null, [stdout, stderr]);
          })
        });

        wm.stdin.end();
      }
    ],
    function(err, results) {
      if (!err) {
        var encoding = results[0];
        var stdoutStr = stringifyBufferArray(results[1][0], encoding);
        var stderrStr = stringifyBufferArray(results[1][1], encoding);
        if (stderrStr) {
          err = new Error(stderrStr);
        }
        cb(err, stdoutStr, pid);
      } else {
        cb(err, '', pid);
      }
    }
  );

  function stringifyBufferArray(array, encoding) {
    return array.map(function(buffer) {
      return iconv.decode(buffer, encoding);
    }).join(',').replace(/^,/, '').replace(/,\s+$/, '').trim();
  }

});

exports.get_value = function(section, value, condition, cb){
  var cond = condition ? ' where "' + condition + '" ' : '';
  var cmd = section + cond + ' get ' + value + ' /value';

  run(cmd, function(err, out){
    if (err) return cb(err);

    var str = out.match(/=(.*)/);

    if (str)
      cb(null, str[1].trim());
    else
      cb(new Error("Wmic: Couldn't get " + value + " in " + section));
  })
}

exports.get_values = function(section, keys, condition, cb){

  var cond = condition ? ' where "' + condition + '" ' : '';
  var cmd = section + cond + ' get ' + keys;

  run(cmd, function(err, out){
    if (err) return cb(err);
    cb(null, parse_values(out));
  });

};


/**
 * Calls back an array of objects for the given command.
 *
 * This only works for alias commands with a LIST clause.
 **/
exports.get_list = function(cmd, callback) {
  run(cmd + ' list full', function(err, data) {
    if (err) return callback(err);
    callback(null, parse_list(data));
  });
};
