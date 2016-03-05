"use strict";

dn.save_pending_requests = [];

dn.SaveTracker = function(){
    this.local = undefined;
    this.remote = undefined;
    return this;
}

dn.save_local_version_counter = 0;

// this list tracks the state of the server, to the best of our knowledge,
// i.e. based on all the respones we have recieved to date (we use the 
// server's "version" number to ensure we maintain the same chronology as the server).
dn.save_server_state = {};

// this is similar to the above but holds SaveRequest instances. Every time
// we construct a new SaveRequest, we update this list.
dn.save_local_state = { };

dn.save = function(parts){
    // this is the only method that should be called by other bits of the program

    // update the status....
    var keys = Object.keys(parts);
    var idx = keys.indexOf('body');
    if(idx >= 0){
        dn.status.save_body = 0;
        keys.splice(idx, 1);
    }
    idx = keys.indexOf('title');
    if(idx >= 0){
        dn.status.save_title = 0;
        keys.splice(idx, 1);
    }
    if(keys.length > 0)
        dn.status.save_other = 0;
    dn.show_status();

    // and construct the (complicated) request..
    dn.save_pending_requests.push(new dn.SaveRequest(parts));
}

dn.SaveRequest = function(parts){
    this._parts = parts

    // update save_local_state 
    var displaced_requests = [];
    for(var k in this._parts) if(this._parts.hasOwnProperty(k)){
        if(dn.save_local_state[k] && !dn.save_local_state[k]._is_settled)
            displaced_requests.push(dn.save_local_state[k]);
        dn.save_local_state[k] = this;
    }

    // see if any of the displaced requests that are still pending, are no longer desired.
    // We can't competely cancel pending requests, but we can make it known that they
    // should stop trying so hard to complete.
    for(var ii=0; ii< displaced_requests.length; ii++){
        var desired = false; // if displaced_requests[ii] is responsible for any of save_local_state, then it is desired still 
        for(var k in dn.save_local_state) if(dn.save_local_state.hasOwnProperty(k))
            if(dn.save_local_state[k] == displaced_requests[ii]){
                desired = true;
                break;
            }
        if(!desired)
            displaced_requests[ii]._desired = false;
    }


    this._desired = true; // see above description and _throw_if_not_desired, to see how this is used
    this._tracker = new dn.SaveTracker(); // hold local and remote version numbers
    this._tracker.local = ++dn.save_local_version_counter;
    this._is_settled = false;
    this._error = undefined;

    var self = this;
    this._pr = until_success(function(succ, fail){
        return Promise.all([dn.pr_auth, dn.pr_file_loaded])
                      .then(self._throw_if_not_desired.bind(self))
                      .then(dn.request_save(self._parts))
                      .then(self._on_completion.bind(self))
                      .catch(self._on_error.bind(self))
                      .then(succ, fail);
    }, dn.pr_auth.reject.bind(dn.pr_auth))
    .then(self._on_finally.bind(self));
    
    return this;
}

dn.SaveRequest.prototype._throw_if_not_desired = function(){
    if(!this._desired)
        throw "not desired"; //caught by on_error, and turned into success
    return true;
}

dn.SaveRequest.prototype._on_error = function(err){
    if(dn.is_auth_error(err)) throw err; // will cause until_success to try again
    if(err !== "not desired")
        this._error = err; // an actual error, record it
    return "error"; //convert to success, and stop trying
}

dn.SaveRequest.prototype._on_completion = function(res){
    this._tracker.remote = parseInt(res.result.version);
    // update 0 or more entries in dn.save_server_state (see description above)
    for(var k in this._parts) if(this._parts.hasOwnProperty(k)){
        if(dn.save_server_state[k] === undefined)
            dn.save_server_state[k] = new dn.SaveTracker();
        if(dn.save_server_state[k].remote === undefined || this._tracker.remote > dn.save_server_state[k].remote){
            dn.save_server_state[k].remote = this._tracker.remote;
            dn.save_server_state[k].local = this._tracker.local;
        }
    }  
    return true;    
}

dn.SaveRequest.prototype._on_finally = function(){
    // called when the until_success deems that success has occured
    // but that means the request was a legitimate failure, or canaceled,
    // though at this point we don't care what happened exactly.

    if(this._error !== undefined){
        dn.show_error("Saving failed. File in unknown state on server. See developer console.");
        console.dir(this._error);
        // abandon all requests, but note they may still continue executing
        while(dn.save_pending_requests.length)
            dn.save_pending_requests.pop()._desired = false;
        // and reset out records to be totally "naive"
        dn.save_server_state = {};
        dn.save_local_state = {};
        
        // show that we're no longer trying to save...
        dn.status.save_body = 1;
        dn.status.save_title = 1;
        dn.status.save_other = 1;
        dn.show_status();
        return;
    }

    // remove from the list of pending requests
    this._is_settled = true;
    dn.save_pending_requests.splice(dn.save_pending_requests.indexOf(this), 1);

    // if other requests are still pending, let them clean up any mess when they're done..
    if(dn.save_pending_requests.length > 0)
        return;

    // dn.save_local_state holds the state we want the server to have, and 
    // dn.save_server_state holds the state the server ended up with 
    // (and remember there are no pending requests), so lets build a list
    // of corrections to make to the server
    var correction = {};
    var correction_need = false;
    for(var k in dn.save_local_state) if(dn.save_local_state.hasOwnProperty(k))
        if(dn.save_server_state[k].local != dn.save_local_state[k]._tracker.local){
            correction[k] = dn.save_local_state[k]._parts[k];
            correction_need = true;
        }

    // and now we can make the request, if we need to..
    dn.status.save_body = 1; // TODO: we could have set these to 1 at an earlier point
    dn.status.save_title = 1;
    dn.status.save_other = 1;
    if (correction_need)
        dn.save(correction); // this will set some of the status's to 0 and call show_status
    else
        dn.show_status();

}



