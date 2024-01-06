function setCurrentTime() {
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    document.getElementById("time").innerHTML = `Current time: <b>${hours}:${minutes}</b> (UTC)`
}

function scheduleSetCurrentTime() {
    setCurrentTime()
    const now = new Date();
    const timeToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();

    // Set a timeout to align with the next minute change
    setTimeout(function() {
        setCurrentTime(); // Print the time at the start of the next minute

        // Then set an interval to print the time every minute thereafter
        setInterval(setCurrentTime, 60 * 1000);
    }, timeToNextMinute);
}

// Start the scheduling function
scheduleSetCurrentTime();


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

            svg.selectAll(".selection-circle").remove();
            svg.selectAll(".vertical-selection-bar").remove();
        
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
            svg.selectAll(".selection-circle").remove();
            
            // Remove any existing wrap-around links
            svg.selectAll(".vertical-selection-bar").remove();
            
            // Line from the last node to the right boundary
            svg.append("line")
            .attr("class", "vertical-selection-bar")
            .attr("x1", mouseX)
            .attr("y1", yScale(0))
            .attr("x2", mouseX)
            .attr("y2", yScale(100))
            .attr("stroke", "black")

            // Draw a white circle at the specified location
            svg.append("circle")
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
            lowerLimit = nodes[svg_name][nodeIndex-1].time
        }
        if (nodeIndex == nodes[svg_name].length-1){
            upperLimit = 1440
        } else{
            upperLimit = nodes[svg_name][nodeIndex+1].time
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
    svg.selectAll(".selection-circle").remove();
    svg.selectAll(".vertical-selection-bar").remove();
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

    row.classList.add('selected');
}

//function checkboxChecked(checkbox){
//    console.log(checkbox.parentElement.parentElement.querySelector(".selectable").innerText, checkbox.checked)
//}

window.onload = function() {
    selectRow(document.querySelector('.selectable'));
};