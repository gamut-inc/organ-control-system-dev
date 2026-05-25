autowatch = 1; 

// RENAME THE CHAINS --------------------------

var slotlist = [];
var api = new LiveAPI(this.patcher);

exports.clear = function(presetNr, silent)
{
	api.path = "this_device canonical_parent devices 0 chains "+presetNr;
   	api.set("name", "--");
    api.set("color", 1);
    if(!silent) post("cleared chain "+presetNr+"\n"); 		
}; 

exports.clearAll = function()
{
	for (var i=0; i<128; i++) {
    	this.clear(i, true);
    }  
    post("cleared all chains\n");
};

exports.rename = function(presetNr, presetName)
{
	api.path = "this_device canonical_parent devices 0 chains "+presetNr;
    api.set("name", "p "+presetNr+": "+presetName);
    api.set("color", 100);
    post("renamed chain"+presetNr+": "+presetName+"\n")
};
