const { Socket } = require('net')
const assert = require('assert')

const RESERVED = 'RESERVED'
const INSERTED = 'INSERTED'
const USING = 'USING'
const TOUCHED = 'TOUCHED'
const DELETED = 'DELETED'
const BURIED = 'BURIED'
const RELEASED = 'RELEASED'
const NOT_FOUND = 'NOT_FOUND'
const OUT_OF_MEMORY = 'OUT_OF_MEMORY'
const INTERNAL_ERROR = 'INTERNAL_ERROR'
const BAD_FORMAT = 'BAD_FORMAT'
const UNKNOWN_COMMAND = 'UNKNOWN_COMMAND'
const EXPECTED_CRLF = 'EXPECTED_CRLF'
const JOB_TOO_BIG = 'JOB_TOO_BIG'
const DRAINING = 'DRAINING'
const TIMED_OUT = 'TIMED_OUT'
const DEADLINE_SOON = 'DEADLINE_SOON'
const FOUND = 'FOUND'
const WATCHING = 'WATCHING'
const NOT_IGNORED = 'NOT_IGNORED'
const KICKED = 'KICKED'
const PAUSED = 'PAUSED'

module.exports = JackdClient

function JackdClient() {
  this.socket = new Socket()
  this.socket.setEncoding('ascii')
}

JackdClient.prototype.connect = async function() {
  const socket = this.socket
  let host, port

  if (arguments.length === 1) {
    const [opts] = arguments
    host = opts.host
    port = opts.port
  }

  await new Promise(resolve =>
    socket.connect(port || 11300, host || undefined, resolve)
  )

  return this
}

JackdClient.prototype.quit = JackdClient.prototype.close = JackdClient.prototype.disconnect = async function() {
  await this.write('quit\r\n')
}

JackdClient.prototype.write = function(string) {
  assert(string)

  return new Promise((resolve, reject) => {
    this.socket.write(string, 'ascii', err => (err ? reject(err) : resolve()))
  })
}

JackdClient.prototype.executeCommand = createCommandHandler(
  command => command,
  response => {
    validateAgainstErrors(response)
    return response
  }
)

JackdClient.prototype.executeMultiPartCommand = createCommandHandler(
  command => command,
  response => {
    validateAgainstErrors(response)
    return function(deferredResponse) {
      return deferredResponse
    }
  }
)

JackdClient.prototype.pauseTube = createCommandHandler(
  (tube, { delay } = {}) => `pause-tube ${tube} ${delay || 0}`,
  response => {
    validateAgainstErrors(response, [NOT_FOUND])
    if (response === PAUSED) return
    invalidResponse(response)
  }
)

/* Producer commands */

JackdClient.prototype.put = createCommandHandler(
  (payload, { priority, delay, ttr } = {}) => {
    assert(payload)
    let string = payload

    if (typeof payload === 'object') {
      string = JSON.stringify(payload)
    }

    const body = Buffer.from(string, 'ascii')
    return `put ${priority || 0} ${delay || 0} ${ttr || 60} ${
      body.length
    }\r\n${payload}\r\n`
  },
  response => {
    validateAgainstErrors(response, [
      BURIED,
      EXPECTED_CRLF,
      JOB_TOO_BIG,
      DRAINING
    ])

    if (response.startsWith(INSERTED)) {
      const [, id] = response.split(' ')
      return id
    }

    invalidResponse(response)
  }
)

JackdClient.prototype.use = createCommandHandler(
  tube => {
    assert(tube)
    return `use ${tube}\r\n`
  },
  response => {
    validateAgainstErrors(response)
    if (response.startsWith(USING)) {
      const [, tube] = response.split(' ')
      return tube
    }
    invalidResponse(response)
  }
)

/* Consumer commands */

JackdClient.prototype.reserve = createCommandHandler(
  () => 'reserve\r\n',
  reserveResponseHandler
)

JackdClient.prototype.reserveWithTimeout = createCommandHandler(
  seconds => `reserve-with-timeout ${seconds}\r\n`,
  reserveResponseHandler
)

function reserveResponseHandler(response) {
  validateAgainstErrors(response, [DEADLINE_SOON, TIMED_OUT])

  if (response.startsWith(RESERVED)) {
    const [, id] = response.split(' ')
    return function(deferredResponse) {
      return { id, payload: deferredResponse }
    }
  }

  invalidResponse(response)
}

JackdClient.prototype.delete = createCommandHandler(
  id => {
    assert(id)
    return `delete ${id}\r\n`
  },
  response => {
    validateAgainstErrors(response, [NOT_FOUND])
    if (response === DELETED) return
    invalidResponse(response)
  }
)

JackdClient.prototype.release = createCommandHandler(
  (id, { priority, delay } = {}) => {
    assert(id)
    return `release ${id} ${priority || 0} ${delay || 0}\r\n`
  },
  response => {
    validateAgainstErrors(response, [BURIED, NOT_FOUND])
    if (response === RELEASED) return
    invalidResponse(response)
  }
)

JackdClient.prototype.bury = createCommandHandler(
  (id, { priority } = {}) => {
    assert(id)
    return `bury ${id} ${priority || 0}\r\n`
  },
  response => {
    validateAgainstErrors(response, [NOT_FOUND])
    if (response === BURIED) return
    invalidResponse(response)
  }
)

JackdClient.prototype.touch = createCommandHandler(
  id => {
    assert(id)
    return `touch ${id}\r\n`
  },
  response => {
    validateAgainstErrors(response, [NOT_FOUND])
    if (response === TOUCHED) return
    invalidResponse(response)
  }
)

JackdClient.prototype.watch = createCommandHandler(
  tube => {
    assert(tube)
    return `watch ${tube}\r\n`
  },
  response => {
    validateAgainstErrors(response)
    if (response.startsWith(WATCHING)) {
      const [, count] = response.split(' ')
      return count
    }
    invalidResponse(response)
  }
)

JackdClient.prototype.ignore = createCommandHandler(
  tube => {
    assert(tube)
    return `ignore ${tube}\r\n`
  },
  response => {
    validateAgainstErrors(response, [NOT_IGNORED])
    if (response.startsWith(WATCHING)) {
      const [, count] = response.split(' ')
      return count
    }
    invalidResponse(response)
  }
)

/* Other commands */

JackdClient.prototype.peek = createCommandHandler(
  id => {
    assert(id)
    return `peek ${id}\r\n`
  },
  response => {
    validateAgainstErrors(response, [NOT_FOUND])
    if (response.startsWith(FOUND)) {
      const [, id] = response.split(' ')
      return function(deferredResponse) {
        return { id, payload: deferredResponse }
      }
    }
    invalidResponse(response)
  }
)

JackdClient.prototype.kick = createCommandHandler(
  bound => {
    assert(bound)
    return `kick ${bound}\r\n`
  },
  response => {
    validateAgainstErrors(response)
    if (response === KICKED) return
    invalidResponse(response)
  }
)

JackdClient.prototype.kickJob = createCommandHandler(
  id => {
    assert(id)
    return `kick-job ${id}\r\n`
  },
  response => {
    validateAgainstErrors(response, [NOT_FOUND])
    if (response === KICKED) return
    invalidResponse(response)
  }
)

JackdClient.prototype.getCurrentTube = createCommandHandler(
  () => `list-tube-used\r\n`,
  response => {
    validateAgainstErrors(response, [NOT_FOUND])
    if (response.startsWith(USING)) {
      const [, tube] = response.split(' ')
      return tube
    }
    invalidResponse(response)
  }
)

function invalidResponse(response) {
  const error = new Error('unexpected-response')
  error.response = response
  throw error
}

function createCommandHandler(commandFunction, responseFunction) {
  return async function command() {
    const socket = this.socket
    let buffer = ''

    await this.write(commandFunction.apply(this, arguments))

    return new Promise((resolve, reject) => {
      socket.on('data', processIncomingData)

      function processIncomingData(chunk, responseFunctionOverride) {
        try {
          buffer += chunk

          const delimiterIndex = buffer.indexOf('\r\n')
          const isLine = delimiterIndex > -1

          if (!isLine) return

          const head = buffer.substring(0, delimiterIndex)
          const tail = buffer.substring(delimiterIndex + 2, buffer.length)

          buffer = ''
          let result = (responseFunctionOverride || responseFunction)(head)

          if (typeof result === 'function' && tail.length) {
            return processIncomingData(tail, result)
          }

          socket.removeListener('data', processIncomingData)
          resolve(result)
        } catch (err) {
          socket.removeListener('data', processIncomingData)
          reject(err)
        }
      }
    })
  }
}

function validateAgainstErrors(response, additionalErrors = []) {
  const errors = [
    OUT_OF_MEMORY,
    INTERNAL_ERROR,
    BAD_FORMAT,
    TIMED_OUT,
    UNKNOWN_COMMAND
  ]

  if (errors.concat(additionalErrors).some(error => response.startsWith(error)))
    throw new Error(response)
}
