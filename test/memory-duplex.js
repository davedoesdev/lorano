var util = require('util'),
    Duplex = require('stream').Duplex;

function RightDuplex(left, options)
{
    Duplex.call(this, options);
    this.left = left;
    this._orig_emit = this.emit;
    this.emit = function (type)
    {
        if (type === 'error')
        {
            var args = Array.prototype.slice.call(arguments);
            process.nextTick(function ()
            {
                left._orig_emit.apply(left, args);
            });
        }

        return this._orig_emit.apply(this, arguments);
    };
}

util.inherits(RightDuplex, Duplex);

RightDuplex.prototype._final = function (cb)
{
    this.left.push(null);
    cb();
};

RightDuplex.prototype._read = function ()
{
    if (this._cb)
    {
        var cb = this._cb;
        this._cb = null;
        process.nextTick(cb);
    }
};

RightDuplex.prototype._write = function (chunk, encoding, cb)
{
    if (this.left.push(chunk, encoding))
    {
        process.nextTick(cb);
    }
    else
    {
        this.left._cb = cb;
    }
};

function LeftDuplex(options)
{
    Duplex.call(this, options);
    this.right = new RightDuplex(this, options);
    this._orig_emit = this.emit;
    this.emit = function (type)
    {
        if (type === 'error')
        {
            var ths = this,
                args = Array.prototype.slice.call(arguments);
            process.nextTick(function ()
            {
                ths.right._orig_emit.apply(ths.right, args);
            });
        }

        return this._orig_emit.apply(this, arguments);
    };
}

util.inherits(LeftDuplex, Duplex);

LeftDuplex.prototype._final = function (cb)
{
    this.right.push(null);
    cb();
};

LeftDuplex.prototype._read = function ()
{
    if (this._cb)
    {
        var cb = this._cb;
        this._cb = null;
        process.nextTick(cb);
    }
};

LeftDuplex.prototype._write = function (chunk, encoding, cb)
{
    if (this.right.push(chunk, encoding))
    {
        process.nextTick(cb);
    }
    else
    {
        this.right._cb = cb;
    }
};

exports.LeftDuplex = LeftDuplex;
