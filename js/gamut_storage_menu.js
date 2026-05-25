autowatch = 1; 

{
	//var pattrstorage = this.patcher.getnamed("gamut_storage");
	var menu_maxobj = this.patcher.getnamed("preset_menu");
	var slotnamelist;

	exports.add = function(slot)
	{
    	slotnamelist.push("p "+slot[0]+": "+slot[1]); 
    	//post("done !\n"+slotnamelist);
	};

	exports.update = function(slotnamelist)
	{
		// menu must have at least 2 positions
		switch(true)
		{
		case slotnamelist==null: 
			{
				slotnamelist = ["--", "--"];
			}; 
			break; 
		case slotnamelist.length==1:
			{
				slotnamelist.push("--")
			}
		};

		// populate the slotnamelist
	    menu_maxobj.setattr("_parameter_range", slotnamelist);
    	post("updated preset menu!\n");
	};

	exports.clearAll = function()
	{
		slotnamelist = [];
		menu_maxobj.message("set", 0);
		menu_maxobj.setattr("_parameter_range", ["--", "--"]);
    	post("MENU cleared preset menu!\n");		
	};

	exports.recall = function()
	{
		post("recall menu\n");
	};

	/*
	exports.recall = function()
	{
		post("MENU recall !!\n");
		let presetToRecall = args[0].split(":")[0].split("p ")[1];
		post("MENU recalling: "+presetToRecall+"\n");
		preset("Recall", Number(presetToRecall));
	}
	*/

};