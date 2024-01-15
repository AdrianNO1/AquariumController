// Define the dimensions and margins of the graph
var margin = {top: 20, right: 20, bottom: 30, left: 50},
    width = 1000 - margin.left - margin.right,
    height = 300 - margin.top - margin.bottom;

// Append the svg object to the body of the page
var mainSvg = d3.select("#graph")
  .attr("width", width + margin.left + margin.right)
  .attr("height", height + margin.top + margin.bottom)

// Define the scales for x and y
var xScale = d3.scaleLinear()
.domain([0, 1439])
.range([0, width]);

var yScale = d3.scaleLinear()
.domain([0, 100])
.range([height, 0]);

var example_nodes = [
    {time: 540, percentage: 20},
    {time: 720, percentage: 50},
    {time: 901, percentage: 30}
];

example_nodes.forEach(function(d) {
    d.x = Math.round(xScale(d.time));
    d.y = Math.round(yScale(d.percentage));
});

var backgroundSvg = mainSvg.append("g").attr("transform", "translate(" + margin.left + "," + margin.top + ")");

let tooltip = backgroundSvg.append("text")
    .style("opacity", 0)
    .attr("text-anchor", "middle")
    .attr("class", "tooltip")
    .attr("dy", "-1em");



let overwriteNodesWithExample = false
let links = {}
let nodes = {}
let selected_radius = 10
let unselected_radius = 4
let link
let node
let selected
let svg_name
let svg
let current_minutes
let codeText
let arduinos

let channels = {}
let channels_names = ["Uv", "Violet", "Royal Blue", "Blue", "White", "Red"]
let channels_colors = ["purple", "violet", "blue", "cyan", "white", "red"]

let channelsTable = document.getElementById("channelsTable")

if (overwriteNodesWithExample){
    channels_names.forEach(e => {
        nodes[e] = structuredClone(example_nodes)
    })
} else{
    $.ajax({
        url: '/load',
        type: 'POST',
        async: false,
        contentType: 'application/json',
        data: JSON.stringify({}),
        success: function(response) {
            nodes = JSON.parse(response.data);
            codeText = JSON.parse(response.code);
            //arduinoConstants = JSON.parse(response.arduinoConstants);
            
        },
        error: function(error) {
            console.log(error);
            document.getElementById("error").textContent = error.responseText
        }
    });
}



let i = 0
channels_names.forEach(e => {
    channelsTable.innerHTML += `<tr><td class="selectable" onclick="selectRow(this)">${e}</td></td></tr>`

    channels[e] = mainSvg
        .append("g")
        .attr("transform", "translate(" + margin.left + "," + margin.top + ")");
    
    initializeSvg(channels[e], e)
    i++
})

function selectSvg(new_svg){
    if (svg){
        svg.selectAll(".node")
            .attr("r", svg_name === new_svg ? selected_radius : unselected_radius)
    }
    tooltip.style("opacity", 0);
    selected = null

    svg_name = new_svg
    svg = channels[new_svg]
    svg.raise()
    refreshGraph(svg)
}


// Define the time format for the x-axis
var timeFormat = d3.timeFormat("%H:%M");

function minutesToTimeFormat(minutes){
    var date = new Date();
    
    var hours = Math.floor(minutes / 60);
    
    var remainingMinutes = minutes % 60;
    
    date.setHours(hours, remainingMinutes, 0, 0);
    
    return timeFormat(date);
}

var customXAxisScale = d3.scaleTime()
    .domain([new Date(0, 0, 0, 0, 0), new Date(0, 0, 0, 23, 59)]) // From midnight to 23:59 of the same day
    .range([0, width]);

// Add the x-axis with more frequent ticks
var xAxis = backgroundSvg.append("g")
    .attr("transform", "translate(0," + height + ")")
    .call(d3.axisBottom(customXAxisScale)
        .ticks(d3.timeHour.every(1)) // Adjust this for the desired tick interval
        .tickFormat(timeFormat)
        .tickSize(-height) // Make the ticks span the entire height for the grid
        .tickPadding(10))
    .call(g => g.select(".domain").remove()) // Remove the axis line
    .call(g => g.selectAll(".tick line").attr("stroke-opacity", 0.2)); // Style the grid lines

// Add the y-axis
var yAxis = backgroundSvg.append("g")
    .call(d3.axisLeft(yScale)
        .tickSize(-width) // Make the ticks span the entire width for the grid
        .tickPadding(10))
    .call(g => g.select(".domain").remove()) // Remove the axis line
    .call(g => g.selectAll(".tick line").attr("stroke-opacity", 0.2)); // Style the grid lines

function setCurrentTime() {
    const now = new Date();
    const hours = now.getUTCHours();
    const minutes = now.getUTCMinutes();
    document.getElementById("current-time").innerHTML = `Current time: <b>${hours}:${minutes}</b> (UTC)`

    backgroundSvg.selectAll(".time-bar").remove();

    current_minutes = hours*60 + minutes

    backgroundSvg.append("line")
        .attr("class", "time-bar")
        .attr("x1", xScale(current_minutes))
        .attr("y1", yScale(0))
        .attr("x2", xScale(current_minutes))
        .attr("y2", yScale(100))
        .attr("stroke", `rgb(100, 100, 100)`)
        .attr("stroke-width", "3");
}

function scheduleSetCurrentTime() {
    setCurrentTime()
    const now = new Date();
    const timeToNextMinute = (60 - now.getUTCSeconds()) * 1000 - now.getUTCMilliseconds();

    // Set a timeout to align with the next minute change
    setTimeout(function() {
        setCurrentTime(); // Print the time at the start of the next minute

        // Then set an interval to print the time every minute thereafter
        setInterval(setCurrentTime, 60 * 1000);
    }, timeToNextMinute);
}

// Start the scheduling function
scheduleSetCurrentTime();

function verifyGraphIntegrity(){
    let ok = true
    channels_names.forEach(e => {
        let first_link
        let prev_link
        getLinks(channels[e]).forEach(link => {
            if (prev_link){
                if (JSON.stringify(prev_link.target) != JSON.stringify(link.source)){
                    ok = false
                }
            } else{
                first_link = link
            }
            prev_link = link
        })
        if (first_link.source.y != prev_link.target.y || first_link.source.percentage != prev_link.target.percentage || first_link.source.time != 0 || prev_link.target.time != 1439){
            ok = false
        }
    })
    return ok
}


function refreshGraph(svg, name=svg_name){
    svg.selectAll(".link").remove();
    svg.selectAll(".node").remove();

    
    //update wraparound links
    var lastNode = nodes[name][nodes[name].length - 1];
    var firstNode = nodes[name][0];
    
    var p1 = [lastNode.x, lastNode.y]
    var p2 = [width + firstNode.x, firstNode.y]
    
    var m = (p2[1] - p1[1]) / (p2[0] - p1[0]);
    
    // Calculate the slope of the original line
    var slope = (p2[1] - lastNode.y) / (p2[0] - lastNode.x);
    
    // Calculate the new y-coordinate for point B using the slope
    var newY = Math.round(lastNode.y + slope * (width - lastNode.x));
    
    // Calculate the y-coordinate when x equals width
    var yPoint = Math.round(m * (width - p1[0]) + p1[1]);
    if (isNaN(yPoint)){
        yPoint = lastNode.y
        newY = lastNode.y
    }
    
    let links_data = [{source: {time: Math.round(xScale.invert(0)), percentage: Math.round(yScale.invert(yPoint)), x: 0, y: yPoint}, target: {time: Math.round(xScale.invert(firstNode.x)), percentage: Math.round(yScale.invert(firstNode.y)), x: firstNode.x, y: firstNode.y}}].concat(d3.range(nodes[name].length - 1).map(i => ({source: nodes[name][i], target: nodes[name][i + 1]}))).concat([{source: {time: Math.round(xScale.invert(lastNode.x)), percentage: Math.round(yScale.invert(lastNode.y)), x: lastNode.x, y: lastNode.y}, target: {time: Math.round(xScale.invert(width)), percentage: Math.round(yScale.invert(newY)), x: width, y: newY}}])
        

        
    // Create the lines
    link = svg.selectAll(".link")
        .data(links_data)
        .enter().append("line")
        .attr("class", "link")
        .attr("x1", d => d.source.x)
        .attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x)
        .attr("y2", d => d.target.y)
        .attr("stroke", channels_colors[Object.keys(channels).indexOf(Object.keys(channels).find(key => channels[key] === svg))])

    // Create the nodes
    node = svg.selectAll(".node")
        .data(nodes[name])
        .enter().append("circle")
        .attr("class", "node")
        .attr("cx", d => d.x)
        .attr("cy", d => d.y)
        .attr("r", name === svg_name ? selected_radius : unselected_radius)
        .attr("fill", channels_colors[Object.keys(channels).indexOf(Object.keys(channels).find(key => channels[key] === svg))])
        .call(d3.drag()
            .on("start", dragstarted)
            .on("drag", dragged)
            .on("end", dragended));


    // Create a text element for the tooltip
    //tooltip = backgroundSvg.append("text")
    //    .style("opacity", 0)
    //    .attr("text-anchor", "middle")
    //    .attr("class", "tooltip")
    //    .attr("dy", "-1em");
//
    //selected = null
}


var placingNode = false

function initializeSvg(svg, name){
    //nodes[name] = structuredClone(example_nodes)
    
    // Add a transparent rect to capture mouse events over the entire SVG area
    svg.append("rect")
        .attr("width", "100%")
        .attr("height", "100%")
        .style("fill", "none") // You can set this to "transparent" or any other color if needed
        .style("pointer-events", "all"); // This ensures that the rect captures mouse events
    

    svg.on("click", function(event) {
        if (placingNode){
            var mouse = d3.pointer(event);
            var mouseX = Math.min(Math.max(mouse[0], 0), width);
            placingNode = false

            backgroundSvg.selectAll(".selection-circle").remove();
            backgroundSvg.selectAll(".vertical-selection-bar").remove();
        
            let links = getLinks(svg)
            for (let i=0; i < links.length; i++){
                let link = links[i]
                if (link.source.x <= mouseX && link.target.x >= mouseX){
                    graphY = link.source.y + ((mouseX - link.source.x)/(link.target.x - link.source.x)) * (link.target.y - link.source.y)
                    let time = Math.round(xScale.invert(mouseX))
                    let percentage = Math.round(yScale.invert(graphY))
                    let newNode = {time: time, percentage: percentage, x: Math.round(xScale(time)), y: Math.round(yScale(percentage))}
                    nodes[svg_name].splice(i, 0, newNode)
                    refreshGraph(svg)
                    break
                }
            }
        }
    })

    svg.on("mousemove", function(event) {
        if (placingNode) {
            var mouse = d3.pointer(event);
            var mouseX = Math.min(Math.max(mouse[0], 0), width);

            let graphY
            let links = getLinks(svg)
            for (let i=0; i < links.length; i++){
                let link = links[i]
                if (link.source.x <= mouseX && link.target.x >= mouseX){
                    graphY = link.source.y + ((mouseX - link.source.x)/(link.target.x - link.source.x)) * (link.target.y - link.source.y)
                    break
                }
            }

            // Remove any existing circles
            backgroundSvg.selectAll(".selection-circle").remove();
            
            // Remove any existing wrap-around links
            backgroundSvg.selectAll(".vertical-selection-bar").remove();
            
            // Line from the last node to the right boundary
            backgroundSvg.append("line")
            .attr("class", "vertical-selection-bar")
            .attr("x1", mouseX)
            .attr("y1", yScale(0))
            .attr("x2", mouseX)
            .attr("y2", yScale(100))
            .attr("stroke", "black")

            // Draw a white circle at the specified location
            backgroundSvg.append("circle")
                .attr("class", "selection-circle")
                .attr("cx", mouseX) // Center x-coordinate of the circle
                .attr("cy", graphY) // Center y-coordinate of the circle, assuming you want it centered vertically
                .attr("r", 4) // Radius of the circle
                .attr("fill", "white"); // Fill color of the circle
        }
    });


    refreshGraph(svg, name)
}


function getLinks(svg){
    let links = []
    
    svg.selectAll(".link").each(e => {
        links.push(e)
    })
    //let i = 0
    //svg.selectAll("line.wrap-around-link").each(function() {
    //    var line = d3.select(this);
    //    var x1 = line.attr("x1");
    //    var y1 = line.attr("y1");
    //    var x2 = line.attr("x2");
    //    var y2 = line.attr("y2");
    //    let link = {source: {time: Math.round(xScale.invert(Number(x1))), percentage: Math.round(yScale.invert(Number(y1))), x: Number(x1), y: Number(y1)}, target: {time: Math.round(xScale.invert(Number(x2))), percentage: Math.round(yScale.invert(Number(y2))), x: Number(x2), y: Number(y2)}}
    //    if (i == 0){
    //        links.push(link)
    //    } else{
    //        links.unshift(link)
    //    }
    //    i++
    //  });
    return links
}


// Update the drag functions to show the tooltip
function dragstarted(event, d) {
    selected = d
    d3.select(this).raise().attr("stroke", "black");
    tooltip.raise()
        .style("opacity", 1)
        .attr("x", d.x)
        .attr("y", d.y + (d.percentage > 95 ? 45 : 0)) // Position the tooltip above the node
        .text(minutesToTimeFormat(d.time) + ", " + Math.round(d.percentage) + "%");
    
    document.getElementById("percentage").value = Math.round(d.percentage) + "%"
    document.getElementById("time").value = minutesToTimeFormat(d.time).toString()
}

function dragged(event, d) {
    // Convert the drag coordinates to time and percentage
    var percentage = Math.min(Math.max(Math.round(yScale.invert(event.y)), 0), 100)
    
    d.percentage = percentage;
    
    let nodeIndex
    for (nodeIndex = 0; nodeIndex < nodes[svg_name].length; nodeIndex++){
        if (nodes[svg_name][nodeIndex] == d){ //(nodes[svg_name][nodeIndex].x == d.x && nodes[svg_name][nodeIndex].y == d.y){ //(Math.abs(nodes[svg_name][nodeIndex].x - d.x) < 10 && Math.abs(nodes[svg_name][nodeIndex].y - d.y) < 10){
            break
        }
    }
    
    let lowerLimit
    let upperLimit
    if (nodeIndex == 0){
        lowerLimit = 0
    } else{
        lowerLimit = nodes[svg_name][nodeIndex-1].x+1
    }
    if (nodeIndex == nodes[svg_name].length-1){
        upperLimit = width
    } else{
        upperLimit = nodes[svg_name][nodeIndex+1].x-1
    }
    
    if (event.x <= upperLimit && event.x >= lowerLimit){
        d.x = event.x;
        d.time = Math.round(xScale.invert(event.x))
        
    } else if (event.x > upperLimit){
        d.x = upperLimit;
        d.time = Math.round(xScale.invert(upperLimit))
    } else{
        d.x = lowerLimit;
        d.time = Math.round(xScale.invert(lowerLimit))
    }
    d.y = Math.round(yScale(percentage));
    
    //nodes[svg_name][nodeIndex].x = d.x
    //nodes[svg_name][nodeIndex].y = d.y
    //nodes[svg_name][nodeIndex].time = d.time
    //nodes[svg_name][nodeIndex].percentage = d.percentage

    d3.select(this)
        .attr("cx", d.x)
        .attr("cy", d.y);
    
    // Update the links
    link.filter(l => l.source === d)
        .attr("x1", d.x)
        .attr("y1", d.y);
    link.filter(l => l.target === d)
        .attr("x2", d.x)
        .attr("y2", d.y);
    tooltip
        .attr("x", d.x + (d.time > 1410 ? -45 : 0) + (d.time < 50 ? 45 : 0))
        .attr("y", d.y + (d.percentage > 95 ? 45 : 0))
        .text(minutesToTimeFormat(d.time) + ", " + Math.round(d.percentage) + "%");
    
    document.getElementById("percentage").value = Math.round(d.percentage) + "%"
    document.getElementById("time").value = minutesToTimeFormat(d.time).toString()

    refreshGraph(svg);
}

function dragended(event, d) {
    d3.select(this).attr("stroke", null);
    //tooltip.style("opacity", 0);
}



document.getElementById("form").addEventListener("submit", function(event) {
    event.preventDefault();
    if (!selected){
        return
    }

    var percentageInput = document.getElementById("percentage").value;
    var timeInput = document.getElementById("time").value;
    var errorMessage = '';

    // Validate percentage
    var percentageValue = percentageInput.replace('%', '');
    var percentage = parseInt(percentageValue, 10);
    if (isNaN(percentage) || percentage < 0 || percentage > 100) {
        errorMessage += 'Percentage must be a number between 0 and 100. ';
    }

    // Validate time
    var timePattern = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
    var isValidTime = timePattern.test(timeInput);
    var time;
    if (isValidTime) {
        var parts = timeInput.split(':');
        time = Number(parts[0]) * 60 + Number(parts[1])


        let nodeIndex
        for (nodeIndex = 0; nodeIndex < nodes[svg_name].length; nodeIndex++){
            if (nodes[svg_name][nodeIndex].x == selected.x && nodes[svg_name][nodeIndex].y == selected.y){
                break
            }
        }
        
        let lowerLimit
        let upperLimit
        if (nodeIndex == 0){
            lowerLimit = 0
        } else{
            lowerLimit = nodes[svg_name][nodeIndex-1].time+1
        }
        if (nodeIndex == nodes[svg_name].length-1){
            upperLimit = 1440
        } else{
            upperLimit = nodes[svg_name][nodeIndex+1].time-1
        }

        if (time > upperLimit || time < lowerLimit){
            errorMessage += "Time out of bounds. "
        }


    } else {
        errorMessage += 'Time must be in the format HH:mm. ';
    }

    // Display error message or results
    if (errorMessage) {
        document.getElementById("error").textContent = errorMessage;
    } else {
        document.getElementById("error").textContent = "";
        
        if (selected) {
            // Update the node data
            selected.percentage = percentage;
            selected.time = time
    
            // Update the node's position based on the new data
            selected.x = xScale(selected.time);
            selected.y = yScale(selected.percentage);

            // Update the node element
            svg.selectAll(".node")
                .filter(d => d === selected)
                .attr("cx", selected.x)
                .attr("cy", selected.y);

            // Update the links connected to the node
            svg.selectAll(".link")
                .filter(l => l.source === selected || l.target === selected)
                .attr("x1", d => d.source.x)
                .attr("y1", d => d.source.y)
                .attr("x2", d => d.target.x)
                .attr("y2", d => d.target.y);

            // Update the tooltip
            tooltip
                .attr("x", selected.x + (selected.time > 1410 ? -45 : 0) + (selected.time < 50 ? 45 : 0))
                .attr("y", selected.y + (selected.percentage > 95 ? 45 : 0))
                .text(minutesToTimeFormat(selected.time) + ", " + Math.round(selected.percentage) + "%");
            
            refreshGraph(svg);
        }
    }
});


document.getElementById("new").addEventListener("click", function(){
    placingNode = !placingNode
    backgroundSvg.selectAll(".selection-circle").remove();
    backgroundSvg.selectAll(".vertical-selection-bar").remove();
})
document.getElementById("delete").addEventListener("click", function(){
    if (selected){
        if (nodes[svg_name].length == 1){
            document.getElementById("error").textContent = "no.";
            return
        }
        document.getElementById("error").textContent = "";
        for (let nodeIndex = 0; nodeIndex < nodes[svg_name].length; nodeIndex++){
            if (nodes[svg_name][nodeIndex].x == selected.x && nodes[svg_name][nodeIndex].y == selected.y){
                nodes[svg_name].splice(nodeIndex, 1)
                refreshGraph(svg)
                break
            }
        }
        tooltip.style("opacity", 0);
        selected = null
    }
})


document.getElementById("upload").addEventListener("click", function(){
    if (!verifyGraphIntegrity()){
        document.getElementById("uploadStatus").textContent = "error: Links are somehow not connected"
        return
    }
    document.getElementById("uploadStatus").textContent = "sending..."
    let links_data = {}
    channels_names.forEach(e => {
        links_data[e] = getLinks(channels[e])
    })
    $.ajax({
        url: '/upload',
        type: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({links_data: links_data, throttle: 100 }),
        success: function(response) {
            console.log(response.message);
            document.getElementById("uploadStatus").textContent = response.message
        },
        error: function(error) {
            console.log(error);
            document.getElementById("uploadStatus").textContent = error
        }
    });
})



function selectRow(row) {
    var rows = document.querySelectorAll('.selectable');
    rows.forEach(function(r) {
        r.classList.remove('selected');
    });

    selectSvg(row.innerText)

    let graphY
    let links = getLinks(svg)
    for (let i=0; i < links.length; i++){
        let link = links[i]
        if (link.source.time <= current_minutes && link.target.time >= current_minutes){
            graphY = link.source.y + ((current_minutes - link.source.time)/(link.target.time - link.source.time)) * (link.target.y - link.source.y)
            break
        }
    }

    
    document.getElementById("percentage").value = Math.round(yScale.invert(graphY)) + "%"
    document.getElementById("time").value = minutesToTimeFormat(current_minutes).toString()

    row.classList.add('selected');
}

//function checkboxChecked(checkbox){
//    console.log(checkbox.parentElement.parentElement.querySelector(".selectable").innerText, checkbox.checked)
//}

window.onload = function() {
    selectRow(document.querySelector('.selectable'));
};

// Initialize the Ace Editor
var editor = ace.edit("editor");
// Set the theme
editor.setTheme("ace/theme/monokai");
// Set the mode to Python
//editor.session.setMode("ace/mode/python");

// Enable basic autocompletion and error annotations
ace.require("ace/ext/language_tools");
editor.setOptions({
    enableBasicAutocompletion: true,
    enableLiveAutocompletion: false,
    enableSnippets: false
});

ace.define('ace/mode/my_custom_mode', ['require', 'exports', 'module', 'ace/lib/oop', 'ace/mode/text', 'ace/mode/text_highlight_rules'], function(require, exports, module) {
var oop = require('ace/lib/oop');
var TextMode = require('ace/mode/text').Mode;
var TextHighlightRules = require('ace/mode/text_highlight_rules').TextHighlightRules;


// Define custom highlight rules
var MyCustomHighlightRules = function() {

    var keywordMapper = this.createKeywordMapper({
        'keyword': 'if|elif|else|to|or|and|not',
        'function': 'analogWrite|isOn|isOff|print',
        'constant': 'Time|Uv|Violet|Royal_Blue|Blue|White|Red'
    }, 'identifier');

    this.$rules = {
        'start': [
            {
                token: 'comment', // Apply comment style
                regex: '#.*$'
            },
            {
                token: 'paren', // Apply style for (
                regex: '[\\(]'
            },
            {
                token: 'paren', // Apply style for )
                regex: '[\\)]'
            },
            {
                token: 'brace', // Apply style for {
                regex: '[\\{]'
            },
            {
                token: 'brace', // Apply style for }
                regex: '[\\}]'
            },
            {
                token: 'string', // Apply style for strings
                regex: '"(?:[^"\\\\]|\\\\.)*"'
            },
            {
                token: keywordMapper,
                regex: '[a-zA-Z_$][a-zA-Z0-9_$]*\\b'
            },
            // ... other rules like strings, numbers, etc.
        ]
    };
};
oop.inherits(MyCustomHighlightRules, TextHighlightRules);

// Define the mode
var Mode = function() {
    this.HighlightRules = MyCustomHighlightRules;
    // ... other mode settings like folding rules, behaviors, etc.
    
    // Define custom behaviors
    this.$behaviour = new (require("ace/mode/behaviour").Behaviour)();
    this.$behaviour.add(":", "insertion", function (state, action, editor, session, text) {
        if (text === '\n') {
            var cursor = editor.getCursorPosition();
            var line = session.doc.getLine(cursor.row);
            if (/:\s*$/.test(line)) { // Check if 'then' is at the end of the line
                // Calculate current indentation
                var indentation = line.match(/^\s*/)[0];
                // Add an extra tab for the new indentation level
                var extraIndent = '\t';
                return {
                    text: '\n' + indentation + extraIndent, // Add a newline and the current indentation plus an extra tab
                    selection: [1, indentation.length + extraIndent.length]
                };
            }
        }
    });
};
oop.inherits(Mode, TextMode);

// Exports the mode
exports.Mode = Mode;
});

// Then, to use your custom mode in the editor:
var editor = ace.edit("editor");
editor.session.setMode('ace/mode/my_custom_mode');

editor.session.setValue(codeText)


// Example of adding a custom error annotation
//editor.session.setAnnotations([{
//    row: 0, // The row (line number, starting at 0)
//    column: 0, // The column (character index, starting at 0)
//    text: "Example error", // The error message
//    type: "error" // The annotation type ('error', 'warning', or 'info')
//}]);
//
// Function to send the code to the Flask app for linting
//function lintCode() {
//    var pythonCode = editor.getValue();
//    fetch('/lint', {
//        method: 'POST',
//        body: pythonCode,
//        headers: {
//            'Content-Type': 'text/plain'
//        }
//    })
//    .then(response => response.json())
//    .then(annotations => {
//        // Update the editor with the linting annotations
//        editor.session.setAnnotations(annotations);
//    })
//    .catch(error => console.error('Error linting code:', error));
//}
//
//// Listen for changes and update annotations
//editor.session.on('change', function() {
//    // Debounce the linting to avoid excessive requests
//    clearTimeout(window.lintingTimeout);
//    window.lintingTimeout = setTimeout(lintCode, 1000);
//});

function setCodeButtonsDisabled(disabled){
    document.getElementById("runonce").disabled = disabled
    document.getElementById("verify").disabled = disabled
    document.getElementById("uploadandrun").disabled = disabled
}


document.getElementById("verify").addEventListener("click", function(){
    setCodeButtonsDisabled(true)
    $.ajax({
        url: '/verify',
        type: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({code: editor.getValue(), arduinos: arduinos.map(x => x.name)}),
        success: function(response) {
            console.log(response);
            if (response.error){
                document.getElementById("codeStatus").innerText = response.error
                document.getElementById("codeStatus").style.color = "red"
            } else{
                document.getElementById("codeStatus").innerText = "OK"
                document.getElementById("codeStatus").style.color = "green"
            }

            setCodeButtonsDisabled(false)
        },
        error: function(error) {
            console.log(error);
            document.getElementById("codeStatus").innerText = error
            document.getElementById("codeStatus").style.color = "red"
            setCodeButtonsDisabled(false)
        }
    });
})

document.getElementById("runonce").addEventListener("click", function(){
    setCodeButtonsDisabled(true)
    $.ajax({
        url: '/run once',
        type: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({code: editor.getValue(), arduinos: arduinos.map(x => x.name)}),
        success: function(response) {
            console.log(response);
            if (response.error){
                document.getElementById("codeStatus").innerText = response.error
                document.getElementById("codeStatus").style.color = "red"
            } else{
                document.getElementById("codeStatus").innerText = "OK\n" + response.message
                document.getElementById("codeStatus").style.color = "green"
            }

            setCodeButtonsDisabled(false)
        },
        error: function(error) {
            console.log(error);
            document.getElementById("codeStatus").innerText = error
            document.getElementById("codeStatus").style.color = "red"
            setCodeButtonsDisabled(false)
        }
    });
})

document.getElementById("uploadandrun").addEventListener("click", function(){
    setCodeButtonsDisabled(true)
    $.ajax({
        url: '/uploadandrun',
        type: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({code: editor.getValue(), arduinos: arduinos.map(x => x.name)}),
        success: function(response) {
            console.log(response);
            if (response.error){
                document.getElementById("codeStatus").innerText = response.error
                document.getElementById("codeStatus").style.color = "red"
            } else{
                document.getElementById("codeStatus").innerText = "OK\n" + response.message
                document.getElementById("codeStatus").style.color = "green"
            }

            setCodeButtonsDisabled(false)
        },
        error: function(error) {
            console.log(error);
            document.getElementById("codeStatus").innerText = error
            document.getElementById("codeStatus").style.color = "red"
            setCodeButtonsDisabled(false)
        }
    });
})



function timeSinceEpochToString(epochSeconds) {
    const secondsPerMinute = 60;
    const secondsPerHour = 3600;
    const secondsPerDay = 86400;

    const now = Math.floor(Date.now() / 1000); // Current time in seconds since epoch
    let elapsed = now - epochSeconds; // Calculate elapsed time in seconds

    if (elapsed < secondsPerMinute) {
        return `${elapsed} seconds ago`;
    } else if (elapsed < secondsPerHour) {
        const minutes = Math.floor(elapsed / secondsPerMinute);
        const seconds = elapsed % secondsPerMinute;
        return `${minutes} minute${minutes > 1 ? 's' : ''} ${seconds} second${seconds > 1 ? 's' : ''} ago`;
    } else if (elapsed < secondsPerDay) {
        const hours = Math.floor(elapsed / secondsPerHour);
        const minutes = Math.floor((elapsed % secondsPerHour) / secondsPerMinute);
        return `${hours} hour${hours > 1 ? 's' : ''} ${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    } else {
        const days = Math.floor(elapsed / secondsPerDay);
        return `${days} day${days > 1 ? 's' : ''} ago`;
    }
}

function editTitle(buttonElement) {
    // Find the title element by navigating the DOM relative to the button
    var titleElement = buttonElement.previousElementSibling;

    if (buttonElement.textContent === 'Edit') {
        // Make the title editable
        titleElement.contentEditable = true;
        titleElement.focus();
        buttonElement.textContent = 'Submit';
    } else {
        // Save the changes and make the title no longer editable
        titleElement.contentEditable = false;
        
        // Here you would also handle saving the new title to your data or server
        var newTitle = titleElement.textContent;
        // Save newTitle to your data or server

        buttonElement.disabed = true
        $.ajax({
            url: '/rename',
            type: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({"device": buttonElement.id, "newname": newTitle}),
            success: function(response) {
                buttonElement.disabed = false
                buttonElement.textContent = 'Edit';
                if (!response.data){
                    console.log(response)
                    document.getElementById("cards status").textContent = response.error
                }
            },
            error: function(error) {
                buttonElement.disabled = false
                console.log(error);
                document.getElementById("cards status").textContent = "Error: Unable to connect"
            }
        });
    }
}

document.getElementById("refresh cards").addEventListener("click", function(){
    document.getElementById("refresh cards").disabed = true
    $.ajax({
        url: '/load arduino info',
        type: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({}),
        success: function(response) {
            document.getElementById("refresh cards").disabed = false
            if (response.data){
                console.log(JSON.parse(response.data))
                arduinos = JSON.parse(response.data);
                
                totalText = ""
                for (arduino in arduinos){
                    arduino = arduinos[arduino]
                    totalText += `<div class="card ${arduino.error ? 'error-background' : ''}">
                    <div class="title">${arduino.name}</div>
                    <button class="edit-button" id=${arduino.device} onclick="editTitle(this)">Edit</button>
                    <div class="subtitle">USB: ${arduino.device}</div>
                    <div class="content error">${arduino.error}</div>       
                    <div class="lastused">Last used: ${timeSinceEpochToString(arduino.lastused)}</div>
                    <div class="status">Status: ${arduino.status}</div>
                    </div>`
                }
                document.getElementById("arduino_cards").innerHTML = totalText
                document.getElementById("cards status").textContent = "OK"
            }
            else{
                console.log(response)
                document.getElementById("cards status").textContent = response.error
            }
        },
        error: function(error) {
            document.getElementById("refresh cards").disabed = false
            console.log(error);
            document.getElementById("cards status").textContent = "Error: Unable to connect"
        }
    });
})

document.getElementById("refresh cards").click()