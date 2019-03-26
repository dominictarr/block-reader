var fs = require('fs')
var mkdirp = require('mkdirp')
var Obv = require('obv')
var path = require('path')

module.exports = function (file, block_size, flags) {
  flags = flags || 'r+'
  var fd
  var offset = Obv()
  var writing = false
  var waitingForWrite = []

  function readyToWrite () {
    if(!writing) throw new Error('should be writing')
    writing = false
    while(waitingForWrite.length)
      waitingForWrite.shift()()
  }

  mkdirp(path.dirname(file), function () {
    //r+ opens the file for reading and writing, but errors if file does not exist.
    //to open the file for reading and writing and not error if it does not exist.
    //we need to open and close the file for append first.
    fs.open(file, 'a', function (_, _fd) {
      fs.close(_fd, function (_) {
        fs.open(file, flags, function (err, _fd) {
          fd = _fd
          fs.stat(file, function (err, stat) {
            offset.set(err ? 0 : stat.size)
          })
        })
      })
    })
  })

  // This variable *only* tracks appends, not positional writes.
  var appending = 0

  return {
    get: function (i, cb) {
      offset.once(function (_offset) {
        function onReady () {
          var max = ~~(_offset / block_size)
          if(i > max)
            return cb(new Error('aligned-block-file/file.get: requested block index was greater than max, got:'+i+', expected less than or equal to:'+max))

          var buf = Buffer.alloc(block_size)

          fs.read(fd, buf, 0, block_size, i*block_size, function (err, bytes_read) {
            if(err) cb(err)
            else if(
              //if bytes_read is wrong
              i < max &&
              buf.length !== bytes_read &&
              //unless this is the very last block and it is incomplete.
              !((i*block_size + bytes_read) == offset.value)
            )
              cb(new Error(
                'aligned-block-file/file.get: did not read whole block, expected length:'+
                block_size+' but got:'+bytes_read
              ))
            else
              cb(null, buf, bytes_read)
          })
        }
        if(!writing) onReady()
        else waitingForWrite.push(onReady)
      })
    },
    offset: offset,
    size: function () { return offset.value },
    append: function (buf, cb) {
      if(appending++) throw new Error('already appending to this file')
        offset.once(function (_offset) {
          fs.write(fd, buf, 0, buf.length, _offset, function (err, written) {
            appending = 0
            if(err) return cb(err)
            if(written !== buf.length) return cb(new Error('wrote less bytes than expected:'+written+', but wanted:'+buf.length))
            offset.set(_offset+written)
            cb(null, _offset+written)
          })
        })
    },
    /**
     * Writes a buffer directly to a position in the file. This opens the file
     * with another file descriptor so that the main file descriptor can just
     * append and read without doing any positional writes.
     *
     * @param {buffer} buf - the data to write to the file
     * @param {number} pos - position in the file to write the buffer
     * @param {function} cb - callback that returns any error as an argument
     */
    write: (buf, pos, cb) => {
      if(flags !== 'r+') throw new Error('file opened with flags:'+flags+' refusing to write unless flags are:r+')
      offset.once((_offset) => {
        const endPos = pos + buf.length
        const isPastOffset = endPos > _offset

        if (isPastOffset) {
          return cb(new Error(`cannot write past offset: ${endPos} > ${_offset}`))
        }

        function onReady (_writing) {
          writing = true
          fs.write(fd, buf, 0, buf.length, pos, (err, written) => {
            readyToWrite()
            if (err == null && written !== buf.length) {
              cb(new Error('wrote less bytes than expected:'+written+', but wanted:'+buf.length))
            } else {
              cb(err)
            }
          })
        }

        if(!writing) onReady()
        else waitingForWrite.push(onReady)
      })
    },
    truncate: function (len, cb) {
      if(appending++) throw new Error('already appending, cannot truncate')
      offset.once(function (_offset) {
        if(_offset <= len) return cb()
        fs.ftruncate(fd, len, function (err) {
          if(err) cb(err)
          else {
            offset.set(len)
            cb(null, offset.value)
          }
        })
      })
    }
  }
}

