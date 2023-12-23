// Define the dimensions and margins of the graph
var margin = {top: 20, right: 20, bottom: 30, left: 50},
    width = 1000 - margin.left - margin.right,
    height = 300 - margin.top - margin.bottom;

// Append the svg object to the body of the page
var svg = d3.select("#graph")
  .attr("width", width + margin.left + margin.right)
  .attr("height", height + margin.top + margin.bottom)
  .append("g")
  .attr("transform", "translate(" + margin.left + "," + margin.top + ")");


// Define the scales for x and y
var xScale = d3.scaleTime()
    .domain([new Date().setHours(0, 0, 0, 0), new Date().setHours(23, 59, 59, 999)])
    .range([0, width]);

var yScale = d3.scaleLinear()
    .domain([0, 100])
    .range([height, 0]);

// Define the time format for the x-axis
var timeFormat = d3.timeFormat("%H:%M");

// Add the x-axis with more frequent ticks
var xAxis = svg.append("g")
    .attr("transform", "translate(0," + height + ")")
    .call(d3.axisBottom(xScale)
        .ticks(d3.timeHour.every(1)) // Adjust this for the desired tick interval
        .tickFormat(timeFormat)
        .tickSize(-height) // Make the ticks span the entire height for the grid
        .tickPadding(10))
    .call(g => g.select(".domain").remove()) // Remove the axis line
    .call(g => g.selectAll(".tick line").attr("stroke-opacity", 0.2)); // Style the grid lines

// Add the y-axis
var yAxis = svg.append("g")
    .call(d3.axisLeft(yScale)
        .tickSize(-width) // Make the ticks span the entire width for the grid
        .tickPadding(10))
    .call(g => g.select(".domain").remove()) // Remove the axis line
    .call(g => g.selectAll(".tick line").attr("stroke-opacity", 0.2)); // Style the grid lines


// Sample data with time of day (as Date objects) and percentage
var nodes = [
    {time: new Date().setHours(9, 0, 0, 0), percentage: 20},
    {time: new Date().setHours(12, 0, 0, 0), percentage: 50},
    {time: new Date().setHours(15, 0, 0, 0), percentage: 30}
];

// Convert the time and percentage to x and y coordinates
nodes.forEach(function(d) {
    d.x = Math.round(xScale(d.time));
    d.y = Math.round(yScale(d.percentage));
});

var links
var radius
var link
var node
var tooltip
var selected

function refreshGraph(){
    svg.selectAll(".link").remove();
    svg.selectAll(".node").remove();
    svg.selectAll(".tooltip").remove();
    // Define the links based on the nodes
    links = d3.range(nodes.length - 1).map(i => ({source: nodes[i], target: nodes[i + 1]}));

    radius = 10;

    // Create the lines
    link = svg.selectAll(".link")
        .data(links)
        .enter().append("line")
        .attr("class", "link")
        .attr("x1", d => d.source.x)
        .attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x)
        .attr("y2", d => d.target.y)
        .attr("stroke", "black");

    // Create the nodes
    node = svg.selectAll(".node")
        .data(nodes)
        .enter().append("circle")
        .attr("class", "node")
        .attr("cx", d => d.x)
        .attr("cy", d => d.y)
        .attr("r", radius)
        .attr("fill", "blue")
        .call(d3.drag()
            .on("start", dragstarted)
            .on("drag", dragged)
            .on("end", dragended));


    // Create a text element for the tooltip
    tooltip = svg.append("text")
        .style("opacity", 0)
        .attr("text-anchor", "middle")
        .attr("class", "tooltip")
        .attr("dy", "-1em");

    selected = null
    updateWrapAroundLink()
}


var placingNode = false

// Add a transparent rect to capture mouse events over the entire SVG area
svg.append("rect")
    .attr("width", "100%")
    .attr("height", "100%")
    .style("fill", "none") // You can set this to "transparent" or any other color if needed
    .style("pointer-events", "all"); // This ensures that the rect captures mouse events

function getLinks(){
    let links = []
    
    svg.selectAll(".link").each(e => {
        links.push(e)
    })
    let i = 0
    svg.selectAll("line.wrap-around-link").each(function() {
        var line = d3.select(this);
        var x1 = line.attr("x1");
        var y1 = line.attr("y1");
        var x2 = line.attr("x2");
        var y2 = line.attr("y2");
        if (i == 0){
            links.push({source: {x: Number(x1), y: Number(y1)}, target: {x: Number(x2), y: Number(y2)}})
        } else{
            links.unshift({source: {x: Number(x1), y: Number(y1)}, target: {x: Number(x2), y: Number(y2)}})
        }
        i++
      });
    return links
}

svg.on("click", function(event) {
    if (placingNode){
        var mouse = d3.pointer(event);
        var mouseX = Math.min(Math.max(mouse[0], 0), width);
        placingNode = false

        svg.selectAll(".selection-circle").remove();
        svg.selectAll(".vertical-selection-bar").remove();
    
        let links = getLinks()
        for (let i=0; i < links.length; i++){
            let link = links[i]
            if (link.source.x <= mouseX && link.target.x >= mouseX){
                graphY = link.source.y + ((mouseX - link.source.x)/(link.target.x - link.source.x)) * (link.target.y - link.source.y)
                let time = xScale.invert(mouseX).getTime()
                let percentage = Math.round(yScale.invert(graphY))
                let newNode = {time: time, percentage: percentage, x: Math.round(xScale(time)), y: Math.round(yScale(percentage))}
                nodes.splice(i, 0, newNode)
                refreshGraph()
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
        let links = getLinks()
        for (let i=0; i < links.length; i++){
            let link = links[i]
            if (link.source.x <= mouseX && link.target.x >= mouseX){
                graphY = link.source.y + ((mouseX - link.source.x)/(link.target.x - link.source.x)) * (link.target.y - link.source.y)
                //console.log(yScale.invert(graphY))
                //console.log(xScale.invert(mouseX))
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


// Function to update or create the wrap-around link
function updateWrapAroundLink() {
    var lastNode = nodes[nodes.length - 1];
    var firstNode = nodes[0];
    
    var p1 = [lastNode.x, lastNode.y]
    var p2 = [width + firstNode.x, firstNode.y]

    var m = (p2[1] - p1[1]) / (p2[0] - p1[0]);

    // Calculate the y-coordinate when x equals width
    var yPoint = m * (width - p1[0]) + p1[1];

    // Remove any existing wrap-around links
    svg.selectAll(".wrap-around-link").remove();

    // Line from the last node to the right boundary
    svg.append("line")
        .attr("class", "wrap-around-link")
        .attr("x1", lastNode.x)
        .attr("y1", lastNode.y)
        .attr("x2", p2[0])
        .attr("y2", p2[1])
        .attr("stroke", "black")

    // Line from the left boundary to the first node
    svg.append("line")
        .attr("class", "wrap-around-link")
        .attr("x1", 0)
        .attr("y1", yPoint)
        .attr("x2", firstNode.x)
        .attr("y2", firstNode.y)
        .attr("stroke", "black")
}

refreshGraph()

// Update the drag functions to show the tooltip
function dragstarted(event, d) {
    selected = d
    d3.select(this).raise().attr("stroke", "black");
    tooltip.raise()
        .style("opacity", 1)
        .attr("x", d.x)
        .attr("y", d.y + (d.percentage > 95 ? 45 : 0)) // Position the tooltip above the node
        .text(timeFormat(d.time) + ", " + Math.round(d.percentage) + "%");
    
    //document.getElementById("percentage").value = Math.round(d.percentage) + "%"
    //document.getElementById("time").value = timeFormat(d.time).toString()
}

function dragged(event, d) {
    // Convert the drag coordinates to time and percentage
    var percentage = Math.min(Math.max(yScale.invert(event.y), 0), 100)
    
    d.percentage = percentage;
    
    let nodeIndex
    for (nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++){
        if (nodes[nodeIndex].x == d.x && nodes[nodeIndex].y == d.y){
            break
        }
    }
    
    let lowerLimit
    let upperLimit
    if (nodeIndex == 0){
        lowerLimit = 0
    } else{
        lowerLimit = nodes[nodeIndex-1].x
    }
    if (nodeIndex == nodes.length-1){
        upperLimit = width
    } else{
        upperLimit = nodes[nodeIndex+1].x
    }
    
    if (event.x <= upperLimit && event.x >= lowerLimit){
        d.x = event.x;
        d.time = xScale.invert(event.x)
    } else if (event.x > upperLimit){
        d.x = upperLimit;
        d.time = xScale.invert(upperLimit)
    } else{
        d.x = lowerLimit;
        d.time = xScale.invert(lowerLimit)
    }
    d.y = yScale(percentage);
    
    
    //console.log(d.x, d.y, d.time)

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
        .attr("x", d.x + (d.time > new Date().setHours(23, 30, 0, 0) ? -45 : 0) + (d.time < new Date().setHours(0, 50, 0, 0) ? 45 : 0))
        .attr("y", d.y + (d.percentage > 95 ? 45 : 0))
        .text(timeFormat(d.time) + ", " + Math.round(d.percentage) + "%");
    
        document.getElementById("percentage").value = Math.round(d.percentage) + "%"
        document.getElementById("time").value = timeFormat(d.time).toString()

    updateWrapAroundLink();
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
        time = new Date();
        time.setHours(parseInt(parts[0], 10), parseInt(parts[1], 10), 0, 0);


        let nodeIndex
        for (nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++){
            if (nodes[nodeIndex].x == selected.x && nodes[nodeIndex].y == selected.y){
                break
            }
        }
        
        let lowerLimit
        let upperLimit
        if (nodeIndex == 0){
            lowerLimit = new Date().setHours(0, 0, 0, 0)
        } else{
            lowerLimit = nodes[nodeIndex-1].time
        }
        if (nodeIndex == nodes.length-1){
            upperLimit = new Date().setHours(23, 59, 59, 999)
        } else{
            upperLimit = nodes[nodeIndex+1].time
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
            selected.time = time.getTime();
    
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
                .attr("x", selected.x)
                .attr("y", selected.y)
                .text(timeFormat(time) + ", " + Math.round(percentage) + "%");
            
            updateWrapAroundLink();
        }
    }
});


document.getElementById("new").addEventListener("click", function(){
    placingNode = true
})
document.getElementById("delete").addEventListener("click", function(){
    if (selected){
        if (nodes.length == 1){
            document.getElementById("error").textContent = "no.";
            return
        }
        document.getElementById("error").textContent = "";
        for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++){
            if (nodes[nodeIndex].x == selected.x && nodes[nodeIndex].y == selected.y){
                nodes.splice(nodeIndex, 1)
                refreshGraph()
                break
            }
        }
        selected = null
    }
})