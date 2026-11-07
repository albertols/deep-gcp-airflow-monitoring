# BACKGROUND and NEW COMPOSER MONITORING a.k.a DEEP_COMPOSER_MONITORING tool

we have migrated gcp composer from v2 to v3.

We were forced to rolled back to some default aiflow tuning to make v3 scale better.

The default GCP Monitoring for Composer can be improved and enhanced to provide more insights into the DAGs and tasks. But , 
especially when it comes to performance issues, autoscale, resource utilization, and task failures, the default GCP Monitoring is not enough.

I am exploring the possibility of using a custom monitoring solution to enhance the observability of our Composer environment. This could involve integrating additional monitoring tools, setting up custom dashboards, and implementing alerting mechanisms to proactively identify and address issues.

I want the tool to be ran in local, pointing to several GCP environemnt (dev, prd, uat, others), so project-id must be setupable in the config file. The tool should be able to connect to GCP Monitoring API and fetch metrics, logs, and other relevant data for the Composer environment. But also to other Airflow, underlying GKE cluster, and other GCP services that are relevant to the Composer environment that are not trivial at first sight to monitor.

Use user friendly interface to visualize the collected metrics and logs, with the ability to filter and drill down into specific DAGs, tasks, and other components. The tool should also provide recommendations for optimizing the Composer environment based on the collected metrics and logs.

Like stats which DAGs are failing more often, which tasks are taking longer than expected, which resources are being underutilized or overutilized, and other performance indicators that can help identify potential issues and bottlenecks in the Composer environment.

The DAG level metrics which ones are ranking the top usage of tasks. The Task parallization issues. Bottlenecks in the DAGs, and other performance indicators that can help identify potential issues and bottlenecks in the Composer environment. Right now there is no way to track the DAG consumption and comparison with other DAGs in the cluster. 
This part is important which will allow us to allocate more resources effectively, but also to understand which DAGs are consuming more resources and which ones are not. This will help us to optimize the Composer environment and improve the overall performance and reliability of the system. But also the DAG tuning recommendator.

We have thousands of Dags, so it is important to consider this; comparing the metrics, usage (slots, tasks, celery , parallelization etc) of the DAGs, and providing recommendations for optimizing the Composer environment based on the collected metrics and logs. The tool should also provide a way to visualize the collected metrics and logs in a meaningful way, with clear and concise visualizations that make it easy to understand the performance and reliability of the Composer environment.
We need stats to comapre metrics and DAGS against each other, and provide recommendations for optimizing the Composer environment based on the collected metrics and logs. The tool should also provide a way to visualize the collected metrics and logs in a meaningful way, with clear and concise visualizations that make it easy to understand the performance and reliability of the Composer environment. at Compsoer-cluster level but also at DAG against DAG, and DAG impacts in the overall performance and reliability of the Composer environment. The tool should also provide a way to visualize the collected metrics and logs in a meaningful way, with clear and concise visualizations that make it easy to understand the performance and reliability of the Composer environment.

it must work in near RealTime (every min or 30s should be enough, although it must be setupable), but keeping resource usage in local as sustainable as possible.

## HIDDEN METRICS
The tool should be able to collect and visualize metrics that are not available in the default GCP and make an impact in the overall performance and reliability of the Composer environment. This could include metrics related to task execution times, resource utilization, and other performance indicators that are not readily available through the default GCP Monitoring. Or any other potential degradation of the system that can be detected by monitoring the underlying GKE cluster, Airflow, and other GCP services.
Resort to the GCP Monitoring API and other relevant APIs to collect these metrics, and provide a way to visualize them in a meaningful way.
Resort to OSS tools and libraries related to Airflow and Compsoer to anticipate potential issues and provide recommendations for optimizing the Composer environment.

## ALERTING
The tool should provide a way to configure alerting mechanisms based on specific thresholds or conditions

## RESEARCH
deepdive into the web if there are any existing open-source tools or libraries that can help with this task. Look for tools that provide a unified view of GCP services, Airflow, and GKE metrics, and that can be easily integrated into a local monitoring solution.

## RUN
The DEEP_COMPOSER_MONITORING tool will run in localhost (Typescript / React) and will provide a better web-based interface for visualizing the collected metrics and logs. The tool should allow users to filter and drill down into specific DAGs, tasks, and other components to view their performance, resource utilization, and error rates. The tool should also provide recommendations for optimizing the Composer environment based on the collected metrics and logs.
For historical data, the tool should be able to store the collected metrics and logs in a local database or file system, so that users can analyze trends and patterns over time. The tool should also provide a way to export the collected data for further analysis or reporting.

## STYLE and THEME
Make the tool extensible, so that new metrics and logs can be added in the future as needed. The tool should also provide a way to configure alerting mechanisms based on specific thresholds or conditions, so that users can be notified of potential issues before they become critical.

It will be launched in local from a git pull from the repo, and the tool should provide a way to configure the GCP project ID, with an easy gcloud auth login (terminal or starting icon in the GUI).

The theme it should use Airflow, GCP Composer Dark Blueish theme, think this as OSS tool that can be used by any GCP Composer user, so it should be easy to use and understand, with clear documentation and instructions for setup and usage. Use similar captions and style as google cloud.

Use online theme for reference to make it look less AI-generated and more like a professional tool.

## CURRENT CONFIG
In this GUI the airflow and composer config must be also shown with links to the official documentation, so that the user can easily understand the configuration and make changes if needed. The tool should also provide recommendations for optimizing the Composer environment based on the collected metrics and logs. But also an (i) icon clickable so that we can do it quickly and what it means to modify it (increase / decrease and what role plays along other values).

## WIKI
We should have a wiki Airflow and Compsoer section, so that the whole team can understand the underlying concepts and architecture. Resort to offical docs, but also provide diagrams with it including the 
   - CloudSQL
   - Celery
   - Scheduler
   - Trigger
   - WebServer
   - GCS
   - Workers, etc
so that this wiki is interactive and breakdown the concepts, but also provide links to the official documentation for each component. The wiki should also include best practices for configuring and optimizing the Composer environment, as well as troubleshooting tips for common issues.
The wiki should provide several interactive and diagrams to understand the flow and state of the DAGs, tasks, and other components in the Composer environment. The diagrams should be interactive and allow users to drill down into specific components to view their configuration, metrics, and logs.

## Validation
Use the Claude Explorer extension for debugging and implementting the tool as validator and evalutor and correct the bugs proactivley

## AIRFLOW local emulator
install a local Airflow emulator or similar if needed to test the tool and its integration with the Composer environment. The emulator should be able to simulate the behavior of the Composer environment, including DAG execution, task scheduling, and resource utilization. This will allow users to test the tool and its features without affecting the production environment.

## CLAUDE
set up the CLAUDE.md, the harness for this tool, apply ADR, Spec driven development, TDD and best practices for software development. The CLAUDE.md should provide a clear and concise overview of the tool's architecture, design decisions, and implementation details. It should also include instructions for setting up the development environment, running tests, and deploying the tool.

keep docuemntation visual using draw.io or similar, and provide a clear and concise overview of the tool's architecture, design decisions, and implementation details. It should also include instructions for setting up the development environment, running tests, and deploying the tool. Create a skill for visual documentation and draw.io and .png exports.