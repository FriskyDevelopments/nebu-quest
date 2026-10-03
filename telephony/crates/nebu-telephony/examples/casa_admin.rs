use nebu_telephony::TelephonyNode;

#[tokio::main]
async fn main() {
    let node = TelephonyNode::from_env();
    let port = node
        .start_pair_server()
        .await
        .expect("casa barra admin server");
    println!("Casa Barra admin panel: http://127.0.0.1:{port}/v1/admin/casa");
    println!("The panel asks for CASA_BARRA_ADMIN_TOKEN. It does not print that key.");
    std::future::pending::<()>().await;
}
