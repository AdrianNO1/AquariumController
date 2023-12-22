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

// Define the links based on the nodes
var links = d3.range(nodes.length - 1).map(i => ({source: nodes[i], target: nodes[i + 1]}));

// ... (rest of the code for creating links and nodes remains the same)

var radius = 10;

// Create the lines
var link = svg.selectAll(".link")
    .data(links)
    .enter().append("line")
    .attr("class", "link")
    .attr("x1", d => d.source.x)
    .attr("y1", d => d.source.y)
    .attr("x2", d => d.target.x)
    .attr("y2", d => d.target.y)
    .attr("stroke", "black");

// Create the nodes
var node = svg.selectAll(".node")
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
var tooltip = svg.append("text")
    .style("opacity", 0)
    .attr("text-anchor", "middle")
    .attr("dy", "-1em");

let selected = null

// Update the drag functions to show the tooltip
function dragstarted(event, d) {
    selected = d
    d3.select(this).raise().attr("stroke", "black");
    tooltip.raise()
        .style("opacity", 1)
        .attr("x", d.x)
        .attr("y", d.y + (d.percentage > 95 ? 45 : 0)) // Position the tooltip above the node
        .text(timeFormat(d.time) + ", " + Math.round(d.percentage) + "%");
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
    
    
    console.log(d.x, d.y, d.time)

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
            console.log(selected.percentage, selected.time)
    
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
        }
    }
});