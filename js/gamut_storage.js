autowatch = 1; 

inlets = 3; 
require("gamut_storage_menu.js");

var g_stopArray = [];
var g_nrOfStops = 0;
var g_presetName; 
var g_pattrstorage_return;
var pattrstorage = this.patcher.parentpatcher.getnamed("storage"); // TODO: put this into 
var menu_maxobj = this.patcher.getnamed("preset_menu"); // TODO: put this into 
var menu = require("gamut_storage_chains.js");

//post(this.patcher.parentpatcher.name+"\n")
var saveDict = new Dict("saveDict");

function anything(...funct)
{
	post("STORAGE :"+funct+"\nfunction not known!\n");
};

function bang()
{
	post("bang")
	menu_maxobjFunct("Update");
}

// the GUI -------------------------------------------------------
/*
function stop(index, p, pos)
{
	this.index = index; 
	this.p = p; 
	this.pos = pos; 
	this.size = [10, 10];

	this.values = 0;

	// create the maxobj:
	this.stop_maxobj = this.p.newdefault(0, 0, "live.text");
	this.stop_maxobj.varname = "stop ";
	this.stop_maxobj.setattr("patching_rect", this.pos[0], this.pos[1]);

	// the callback function: 
	var StopCallback = (function(data)
	{
		this.values = data.value;
	}).bind(this);

	// the listener: 
	this.objListener = new MaxobjListener(this.stop_maxobj, StopCallback);


	this.SetRect = function(pos)
	{	
		this.pos = pos;
		this.stop_maxobj.setattr("patching_rect", this.pos[0], this.pos[1]);
	}

	this.SaveToDict = function(saveDict)
	{
		saveDict.replace("stop "+this.index+" pos", JSON.stringify(this.pos));
		saveDict.replace("stop "+this.index+" values", JSON.stringify(this.values));
	};

	this.LoadFromDict = function(dict)
	{
		var pos = JSON.parse(dict.get("stop "+this.index+" pos"));
		var values = JSON.parse(dict.get("stop "+this.index+" values"));
		
		this.SetRect(pos);

		this.values = values;
		this.stop_maxobj.setvalueof(values);
	}

	this.Destroy = function()
	{
		this.p.remove(this.stop_maxobj);
	};
};

function create_stop(posX, posY)
{
	g_stopArray.push(new stop(g_nrOfStops, this.patcher, [posX, posY]));
	g_nrOfStops++;
}

function delete_ui()
{
	for(i in g_stopArray)
	{
		g_stopArray[i].Destroy();
	};
	g_stopArray = [];
	g_nrOfStops = 0;
}
*/
// DIALOG ----------------------------------

// open a dialog window and execute, text of box
// type = "dialog", "opendialog", "savedialog"
function dialog(type, mode, label, text, funcName){
	var dialog_maxobj = this.patcher.getnamed(type)
	var message;

	switch(type)
	{
		case "dialog": 
			{
				// set the mode of the dialog:
				dialog_maxobj.setattr("mode", mode);

				// set the dialog label:
				dialog_maxobj.setattr("label", label);
			};
			break;
		case "opendialog": 
			{

			};
			break;
		case "savedialog": 
			{

			};
			break; 
	};

	// open the dialog box:
	dialog_maxobj.message(["symbol", text]);		

	this.FromDialog = function(first, ...args)
	{
		if(first=="CANCEL")
		{
			post("CANCEL\n");
		}else
		{
			// inject the prompt from the dialogbox into function
			post("OK!\n");
			runFunct(funcName, args);
			
		}
	};
	
};

// call any function called funcName:
function runFunct(funcName, args){
	if (typeof this[funcName] === "function") {
        
        this[funcName](args); // Call the function by name
        //return true; 
    } else {
        post("Function not found: " + funcName + "\n");
        //return false;
    }
};

//
function dodo ()
{
	post("dodo");
	post();
}


// PROMPTS ----------------------------------------------------------------


function preset(funct, presetNr)
{
	var pattrstorage;

	try {
		pattrstorage = this.patcher.parentpatcher.getnamed("storage");
	} catch {
		post("no pattrstorage in parentpatcher\n"); 
		return; 
	};
	//var pattrstorage = this.patcher.box.patcher.getnamed("gamut_storage");

	// STORING: 
/*
1) check if preset with same nr exists
2) is TRUE:
		- get slotname 
		- prompt if overwrite 
		if TRUE:
			- go to 3)
		if FALSE: abort
3) if FALSE: prompt for presetName
4) store 
5) rename chain
6) add or replace the selector 
*/
	// store 
	this.Store = function(presetNr)
	{
		var patterstorage_return; 
		var slotname =""; 
	
		// the return from pattrstorage
		this.FromPattrstorage = function(first, ...args)
		{	
			pattrstorage_return = args;
		};
	
		// ask for preset name
		this.PromptForPresetName = function()
		{
			dialog("dialog", 0, "store PRESET "+presetNr, slotname, "Store");
		};
	
		this.Store = function(presetName){
			// store the preset
			pattrstorage.message("store", presetNr, presetName);
			// rename the chain
			chains("Rename", presetNr, presetName);
			// update the menu_maxobj
			menu_maxobjFunct("Update");
		}
	
		// check if preset exists in pattrstorage
		// pattrstorage_return will be slotlist
		pattrstorage.message("getslotlist");
	
		// if exists, ask if you´re sure
		if(pattrstorage_return.includes(presetNr))
		{
			// pattrstorage_return will be the slotname
			pattrstorage.message("getslotname", presetNr);
			slotname = pattrstorage_return[1];
			dialog("dialog", 2, "PRESET "+presetNr+": \""+slotname+"\"\nexists. Overwrite?", "", "PromptForPresetName");
		} else
		{
			PromptForPresetName();
		};
	};

	// RECALL A PRESET: 
	/* 
	1) recall the preset 
	2) check which index in slotlist the preset is
	3) check if clientlist includes hybr - if TRUE, send again all the hybr related 
	4) slotname to selector ? 
	*/
	
	this.MenuRecall = function(presetLabel)
	{	
		// extract the presetNr from menu_maxobj label 
		var presetNr = presetLabel.split(":")[0].split(" ")[1];
		presetNr = Number(presetNr);
		this.Recall("default", presetNr);
	};

	this.NoteInputRecall = function(presetNr)
	{

		// recall the preset directly 
		try{
			presetNr = Number(presetNr);
			this.Recall("default", presetNr);
		} catch {
			post("NoteInputRecall: presetNr "+presetNr+" ERROR, can´t recall\n");
			return; 
		};


		pattrstorage.message("getslotlist");

		this.FromPattrstorage = function(...args)
		{	
			post("something is coming\n");
			pattrstorage_return = args;
		};

		post("NoteInputRecall "+pattrstorage_return+"\n");

	};
	
	this.Recall = function (funct, presetNr)
	{
		var patterstorage_return;


		// the return from pattrstorage
		this.FromPattrstorage = function(...args)
		{	
			pattrstorage_return = args;
		};
	
		/*
		// TO DO !!!
		// hybr need to be delayed by 5 sec except for power
		this.recallHybr = function(presetNr)
		{	
			var clients = ["organs::hybr::hybr noise", "organs::hybr::hybr tuning", "organs::hybr::hybr wave", 
				"organs::hybr::dynamics::hybr volume", "organs::hybr::vib::hybr vib speed", "organs::hybr::vib::hybr vib depth", 
				"organs::hybr::adsr::hybr attack time", "organs::hybr::adsr::hybr attack time", "organs::hybr::adsr::hybr attack level",
				"organs::hybr::adsr::hybr decay time", "organs::hybr::adsr::hybr release time", "organs::hybr::trem::hybr trem speed", 
				"organs::hybr::trem::hybr trem depth"];
		
				// TO DO: wait for 5 sec - no blocking ! 
		
				// send the remaining messages: 
				for(var index in clients)
				{	
					pattrstorage.message("recall", clients[index], presetNr);
				}
		};
		*/
		//post("presetNr: "+presetNr+"\n");
	
		//post("funct: "+funct+" presetNr: "+presetNr+"\n");
	
		switch(funct)
		{
		case "Previous": 
			{
				this.CurrentMenuIndex = this.GetCurrentMenuIndex();
				menu_maxobj.message("int", this.CurrentMenuIndex-1);
				post("previous !\n")
			}; 
			break; 
		case "Current": 
			{
				this.CurrentMenuIndex = this.GetCurrentMenuIndex();
				menu_maxobj.message("int", this.CurrentMenuIndex);
				post("current !\n")
			};
			break;
		case "Next": 
			{
				this.CurrentMenuIndex = this.GetCurrentMenuIndex();
				menu_maxobj.message("int", this.CurrentMenuIndex+1);
				post("next !\n")
			}
		default: 
			{
				// aks pattrstorage for slotlist
				pattrstorage.message("getslotlist");
		
				// check if presetNr is already stored: 
				if(pattrstorage_return.includes(presetNr))
				{
					// recall the preset 
					pattrstorage.message("recall", presetNr);
			
					/*
					// check if hybr is client 
					if(saveDict.getkeys().includes("organs::hybr::hybr power"))
					{
						recallHybr(presetNr);
					}
					*/
			
					post("recalled preset "+presetNr+"\n");
				} else
				{
					post("preset "+presetNr+" does not exist !\n");
				};
			};
		};
	};
	
	this.Delete = function(presetNr)
	{
		this.DeletePreset = function()
		{
			pattrstorage.message("delete", presetNr);
			chains("Clear", presetNr);
			menu_maxobjFunct("Update");
			post("Delete: deleted preset "+presetNr+"\n");
		};
	
		dialog("dialog", 2, "Sure to delete \nPRESET "+presetNr+"?", "", "DeletePreset");
	
	};
	
	this.DeleteAll = function()
	{
		this.DeleteAllPresets = function()
		{
			pattrstorage.message("clear");
			chains("ClearAll");
			menu_maxobjFunct("Clear");
			dialog("dialog", 1, "Deleted all presets.", "", "");
			post("deleted all presets.\n");
		}
	
		this.Doublecheck = function()
		{
			dialog("dialog", 2, "SURE ???", "", "DeleteAllPresets");
		}
	
		dialog("dialog", 2, "This will delete all presets. \nAre you sure???", "", "Doublecheck");
	
	}
	
	this.GetCurrentMenuIndex = function()
	{
		this.current; 
		this.slotlist;
		this.currentIndex;
	
		
		// the return from pattrstorage
		this.FromPattrstorage = function(...args)
		{	
			pattrstorage_return = args;
		};
	
		// find out what the current preset is 
		pattrstorage.message("getcurrent");
		this.current = pattrstorage_return[1]; 
	
		pattrstorage.message("getslotlist");
		this.slotlist = pattrstorage_return;
	
		this.currentIndex = this.slotlist.indexOf(current)-1;
	
		post("currentIndex: "+currentIndex+"\n");
		return(currentIndex);
	};

	this.Retrigger = function()
	{
		/*
		for(let id in g_organ.obj.manualArrayObject)
		{
			let manual = g_organ.obj.manualArrayObject[id];
			if(manual.stopArray)
			{
				for(let i in manual.stopArray)
				{

				}
			}
		}
		post("retriggered stops\n");
		*/
	};
	
	
	// RUN THE SELECTED FUNCTIONS: 
	runFunct(funct, presetNr);
};


/*
function read()
{
	// save file first? 
	// opendialog
}

function write()
{
	// savedialog 
};	
//*/

// RENAME THE CHAINS --------------------------

var slotlist = [];

function chains(funct, presetNr, presetName)
{
	var api = new LiveAPI(this.patcher);

	this.Clear = function(presetNr, silent)
	{
		api.path = "this_device canonical_parent devices 0 chains "+presetNr;
       	api.set("name", "p "+presetNr);
        api.set("color", 1);
        if(!silent) post("cleared chain "+presetNr+"\n"); 		
	}; 

	this.ClearAll = function()
	{
    	for (var i=0; i<128; i++) {
        	Clear(i, true);
        }  
        post("cleared all chains\n");
	};

	this.Rename = function()
	{
		api.path = "this_device canonical_parent devices 0 chains "+presetNr;
        api.set("name", "p "+presetNr+": "+presetName);
        api.set("color", 100);
        post("renamed chain"+presetNr+": "+presetName+"\n")
	}

	runFunct(funct, presetNr);

};

// PRESET menu_maxobj ---------------------------------------------------------

function menu_maxobjFunct(funct, ...args){
	var menu_maxobj = this.patcher.getnamed("preset_menu");
	var pattrstorage = this.patcher.parentpatcher.getnamed("storage");
	var slotnamelist = [];

	this.Add = function(slot)
	{
    	slotnamelist.push("p "+slot[0]+": "+slot[1]); 
    	//post("done !\n"+slotnamelist);
	};

	this.FromPattrstorage = function(first, ...args)
	{
		if(args.length>1 && args[1]!="(undefined)") Add(args);
	}

	this.Update = function()
	{
		slotnamelist = [];
		
		// get the nameslist from pattrstorage
		pattrstorage.message("getslotnamelist");

		if(slotnamelist.length<2) slotnamelist.push("--")

		// populate the slotnamelist
	    menu_maxobj.setattr("_parameter_range", slotnamelist);
    	post("updated preset menu_maxobj!\n");
	};

	this.Recall = function()
	{
		let presetToRecall = args[0].split(":")[0].split("p ")[1];
		post("menu_maxobj recalling: "+presetToRecall+"\n");
		preset("Recall", Number(presetToRecall));
	};

	this.Clear = function()
	{
		menu_maxobj.setattr("_parameter_range", ["--", "--"]);
	}

	runFunct(funct)

};




// PATTR SYSTEM -------------------------------------------------

// SAVE values: 
function getvalueof()
{
	var saveDict = new Dict("saveDict");
	saveDict.clear();

	for(var index in g_stopArray){
		g_stopArray[index].SaveToDict(saveDict);
	}

	saveDict.replace("number_of_stops", JSON.stringify(g_nrOfStops));
	saveDict.replace("presetName", g_presetName);

	return saveDict;
};

// LOAD values: 
function setvalueof(dict)
{
	var nrOfStops = JSON.parse(dict.get("number_of_stops"));

	if(g_stopArray.length != nrOfStops)
	{
		delete_ui();
		var index = 0; 
		for(var i=0; i<nrOfStops; i++)
		{
			g_stopArray.push(new stop(index, this.patcher, [0, 0]));
			index++;
		}

	};

	for(var index in g_stopArray)
	{
		g_stopArray[index].LoadFromDict(dict);
	}
};
